/**
 * 界面交互探针：启动应用、在**真实窗口**里触发交互、读回结果、再关掉它。
 *
 * 存在的理由：渲染层的 bug 有一类是「必定发生但完全静默」的 —— 异常抛在
 * nextTick 之后的微任务里，没人捕获，界面上一点反应都没有。截图看不出来，
 * debug.log 里也没有（那只记主进程的生命周期）。比如 `v-for` 作用域里的
 * `ref="x"` 会被编译器打上 `ref_for`，运行时 `x.value` 变成 `[el]`，
 * `x.value?.focus()` 骗不过去 —— 输入框渲染出来了、就是没聚焦，用户双击
 * 改名后敲键盘毫无反应，控制台之外没有任何线索。
 *
 * 做法：主进程在 TM_DEBUG=1 时打开 CDP 端口 9223（见 src/main/index.ts），
 * 本脚本连上去，在渲染进程里真的派发 dblclick / keydown，读 DOM 的实际状态，
 * 最后再读一次磁盘上的 config.json，确认「该存的存了、不该存的没存」。
 * 零依赖：Node 24 自带 fetch 与 WebSocket。
 *
 * 隔离：整轮跑在一次性 profile 目录（spike/.probe-profile）里，通过
 * TM_USER_DATA 换掉 userData，**不碰用户真实的 config.json**。
 *
 * 用法：`node spike/ui-probe.mjs [项目目录...]`
 * （不传则用仓库自带的夹具 spike/fixture 与 spike/fixture-web）
 * 退出码 0 = 全部断言通过。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CDP_PORT = Number(process.env.TM_CDP_PORT ?? 9223)
const RENDERER_HINT = '5273'
const PROFILE = join(HERE, '.probe-profile')
const CONFIG = join(PROFILE, 'config.json')

/**
 * 截图目录。声明留在最外层，别挪进下面任何一段。
 *
 * 截图是按需开启的（默认不拍，免得每次跑探针都在仓库里留下二进制文件），而几乎
 * 每一段都可能想拍一张。声明一旦落在中间，插在它前面的新段引用 SHOT_DIR 就会撞
 * TDZ：`Cannot access 'SHOT_DIR' before initialization` —— 表现是探针跑到一半
 * 整个崩掉，而报错行看着跟你刚写的那段毫无关系。
 */
const SHOT_DIR = process.env.TM_SHOT_DIR

/**
 * 默认素材：仓库自带的两个夹具项目。
 * 「移动到…」等断言要求至少有 2 个同级分组，所以这里必须给够两个。
 * 想换成自己的真实项目，直接命令行传参即可。
 */
const DEFAULT_PROJECTS = [join(HERE, 'fixture'), join(HERE, 'fixture-web')]
const projects = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const projectDirs = projects.length ? projects : DEFAULT_PROJECTS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------

class Cdp {
  constructor(url) {
    this.url = url
    this.seq = 0
    this.pending = new Map()
    /** 渲染进程里未被捕获的异常，按到达顺序累积 */
    this.exceptions = []
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 出错'))
      }
      ws.onmessage = (event) => {
        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: done, reject: fail } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) fail(new Error(msg.error.message))
          else done(msg.result)
          return
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params?.exceptionDetails
          this.exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown')
        }
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /** 在渲染进程里求值；表达式自身抛错会变成 reject（而不是静默 undefined） */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description ?? d.text ?? 'evaluate 抛错')
    }
    return r.result.value
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // 关不掉无所谓，进程马上结束
    }
  }
}

// ---------------------------------------------------------------------------
// 找页面 target
// ---------------------------------------------------------------------------

async function waitForTarget(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && String(t.url).includes(RENDERER_HINT))
      if (page?.webSocketDebuggerUrl) return page
      lastErr = `targets=${list.map((t) => t.type).join(',') || 'empty'}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await sleep(400)
  }
  throw new Error(`等不到 CDP 页面 target（端口 ${CDP_PORT}）：${lastErr}`)
}

/** 轮询等到渲染进程里出现可交互的树行 */
async function waitForRows(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await cdp.evaluate(`document.querySelectorAll('.tree-pane .row.group').length`)
    if (count > 0) return count
    await sleep(300)
  }
  throw new Error('等不到分组树渲染出行（界面没挂载，或数据为空）')
}

// ---------------------------------------------------------------------------
// 启停
// ---------------------------------------------------------------------------

function killStrayElectron() {
  // 残留实例持有单实例锁，会让下一次启动静默 exit 0 —— 探针会卡在等窗口上
  spawnSync('taskkill', ['/IM', 'electron.exe', '/T', '/F'], { stdio: 'ignore' })
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

function launchApp() {
  // stdout 必须是文件而不是管道：走管道时应用会自己退出（见 docs/技术方案.md 附录 B）
  const logFd = openSync(join(HERE, 'probe-dev.log'), 'a')
  // `.cmd` 不能直接 spawn —— Node 18.20 起为修 CVE-2024-27980 会直接拒绝，
  // 报 `Error: spawn EINVAL`。这里走 shell 是安全的：命令是写死的常量，
  // 既没有用户输入，也没有带空格的路径（应用自身 spawn 用户命令时才必须避开 shell）。
  const child = spawn('npm run dev', {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, TM_DEBUG: '1', TM_USER_DATA: PROFILE },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  return child
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const seed = spawnSync('node', ['spike/seed.ts', CONFIG, ...projectDirs], {
  cwd: ROOT,
  encoding: 'utf-8',
})
if (seed.status !== 0) {
  console.error('[probe] seed 失败：', seed.stderr || seed.stdout)
  process.exit(1)
}
console.log(`[probe] 已 seed 一次性 profile：${CONFIG}`)

// 「移动到…」的断言要用真实的分组 id：抓刚 seed 出来的两个同级子分组，
// 让探针建的那条命令只在它们之间搬。命令不能移到根级 —— 工作目录是从最近的
// 带 path 的祖先分组继承的，挂到根上会变成一张按不了「启动」的废卡片。
const seedCfg = JSON.parse(readFileSync(CONFIG, 'utf-8'))
const seedRoot = seedCfg.nodes.find((n) => n.kind === 'group' && n.parentId === null)
const seedSiblings = seedCfg.nodes.filter((n) => n.kind === 'group' && n.parentId === seedRoot.id)
if (seedSiblings.length < 2) {
  console.error('[probe] seed 出来的同级分组少于 2 个，「移动到…」没法测')
  process.exit(1)
}

killStrayElectron()
const app = launchApp()
let exitCode = 1

try {
  const target = await waitForTarget()
  console.log(`[probe] target: ${target.url}`)

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const groupRows = await waitForRows(cdp)
  console.log(`[probe] 分组行 ${groupRows} 行，开始触发交互`)

  // --- 1. 双击重命名：输入框必须真的拿到焦点 -----------------------------
  //
  // 这正是 `v-for` + 命名 ref 的翻车点：输入框会渲染出来，但 focus() 抛错，
  // 焦点留在原处，用户双击后敲键盘没有任何反应，也没有任何报错提示。
  const renameProbe = await cdp.evaluate(`(async () => {
    const row = document.querySelector('.tree-pane .row.group')
    if (!row) return { error: '找不到分组行' }
    const before = row.querySelector('.label')?.textContent ?? null
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const input = row.querySelector('.rename-input')
    return {
      before,
      hasInput: Boolean(input),
      focused: Boolean(input) && document.activeElement === input,
      value: input ? input.value : null,
    }
  })()`)

  check('双击分组后出现重命名输入框', renameProbe.hasInput === true, JSON.stringify(renameProbe))
  check(
    '重命名输入框真的拿到了焦点（v-for ref 修复的直接证据）',
    renameProbe.focused === true,
    `activeElement 是否等于输入框：${renameProbe.focused}`,
  )

  // --- 2. Esc 必须「取消」，不能把改动提交上去 ---------------------------
  //
  // Chromium 在移除聚焦元素时会补发 blur，而 blur 绑的是提交。只关编辑态、
  // 不清草稿的话，用户按 Esc 反而会把刚敲的字写进配置 —— 与意图完全相反。
  const escProbe = await cdp.evaluate(`(async () => {
    const row = document.querySelector('.tree-pane .row.group')
    const input = row.querySelector('.rename-input')
    if (!input) return { error: '没有输入框，跳过' }
    // 基线取 input.value 而不是 .label 的文本：此刻 .label 已经被输入框顶掉了，
    // 查它是 null —— 拿 null 当基线会让断言永远失败，看着像产品 bug，
    // 其实是探针自己读错了地方。
    const before = input.value
    input.value = '不该被保存的名字'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const after = document.querySelector('.tree-pane .row.group .label')?.textContent ?? null
    return { before, after, stillEditing: Boolean(document.querySelector('.tree-pane .rename-input')) }
  })()`)

  check(
    'Esc 取消重命名后名字没有被改动',
    escProbe.after === escProbe.before,
    `${escProbe.before} → ${escProbe.after}`,
  )
  check('Esc 后退出编辑态', escProbe.stillEditing === false, `stillEditing=${escProbe.stillEditing}`)

  // --- 3. Enter 必须真的改掉名字（证明重命名功能整体可用） ----------------
  const enterProbe = await cdp.evaluate(`(async () => {
    const row = document.querySelector('.tree-pane .row.group')
    const before = row.querySelector('.label')?.textContent ?? null
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const input = row.querySelector('.rename-input')
    if (!input) return { error: '双击后没有出现输入框' }
    input.value = '探针改名OK'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 600))
    const after = document.querySelector('.tree-pane .row.group .label')?.textContent ?? null
    return { before, after }
  })()`)

  check('Enter 提交后名字确实变了', enterProbe.after === '探针改名OK', `${enterProbe.before} → ${enterProbe.after}`)

  // --- 4. 全程不许有未捕获异常 -------------------------------------------
  await sleep(300)
  check(
    '渲染进程全程没有未捕获异常',
    cdp.exceptions.length === 0,
    cdp.exceptions.length ? cdp.exceptions.join(' | ') : '无',
  )

  // --- 5. 清空「预期端口」能不能真的生效 ---------------------------------
  //
  // 唯一一处依赖「值为 undefined 的自有属性能否跨结构化克隆」的地方：表单清空
  // 端口时放进 patch 的是 `expectedPort: undefined`，主进程用 `in` 判定。
  // 按 HTML 结构化克隆规范 `undefined` 是会被保留的（不同于 JSON.stringify），
  // 但这条语义没被验证过，而失效时的症状是「端口改不掉、总是弹回旧值」，
  // 很难归因。这里直接走一次真实 IPC，把疑问变成断言。
  const portProbe = await cdp.evaluate(`(async () => {
    const list = await window.api.tree.list()
    const target = list.find((n) => n.kind === 'command' && n.expectedPort)
    if (!target) return { error: '没有带预期端口的命令节点' }
    const before = target.expectedPort
    await window.api.tree.update({ id: target.id, expectedPort: undefined })
    const after = (await window.api.tree.list()).find((n) => n.id === target.id)?.expectedPort
    return { name: target.name, before, after: after ?? null }
  })()`)

  check(
    '预期端口可以被清空（undefined 跨结构化克隆后仍被保留）',
    portProbe.after === null,
    JSON.stringify(portProbe),
  )

  // --- 6. 改主题能不能即时影响渲染进程 -----------------------------------
  //
  // 主题的唯一落地点在主进程（`src/main/theme.ts` 改 `nativeTheme.themeSource`），
  // 渲染层一行主题代码都没有。这里验证的正是那条链是否真的接通：
  // IPC 改设置 → 主进程改 themeSource → 渲染进程的 prefers-color-scheme 重新求值。
  //
  // 值得专门断言，是因为它断掉时的症状极其隐蔽：界面上什么都没发生、也没有
  // 任何报错、控制台干干净净，用户只会觉得「这个选项是坏的」，而我们从日志里
  // 看不到任何线索。截图也只能证明「启动时按配置上色了」，证明不了这一条 ——
  // 启动走的是另一条代码路径（bootstrap 里在建窗口之前应用）。
  const themeProbe = await cdp.evaluate(`(async () => {
    const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
    const before = isDark()
    await window.api.settings.update({ theme: 'light' })
    await new Promise((r) => setTimeout(r, 400))
    const afterLight = isDark()
    await window.api.settings.update({ theme: 'dark' })
    await new Promise((r) => setTimeout(r, 400))
    const afterDark = isDark()
    // 还原成跟随系统，免得这次探针把 profile 留在某个固定主题上
    await window.api.settings.update({ theme: 'system' })
    return { before, afterLight, afterDark }
  })()`)

  check(
    '切主题即时改变 prefers-color-scheme（主进程 themeSource 接通）',
    themeProbe.afterLight === false && themeProbe.afterDark === true,
    JSON.stringify(themeProbe),
  )

  // --- 6b. 日志面板：默认收起，展开/收起按钮真的接通 ------------------------
  //
  // 「默认收起」这个取舍能成立，全靠失败时自动摊开（见最后一节）—— 少了那一环，
  // 收起就等于把报错一起藏了。
  //
  // 这里不去断言「此刻 DOM 里没有正文」当作默认值的证据：探针跑在前面的几个小节
  // 已经启过命令，而任何一条非零退出都会把面板掀开，断言就会时灵时不灵。默认值去
  // 问设置本身（全新 profile 才读得到 true），DOM 只用来验「设置和界面一致」。
  const logDefault = await cdp.evaluate(`(async () => {
    const s = await window.api.settings.get()
    const btn = [...document.querySelectorAll('.log-pane .log-head .btn')]
      .find((b) => ['收起', '展开'].includes((b.textContent || '').trim()))
    return {
      setting: !!s.logCollapsed,
      hasBody: !!document.querySelector('.log-pane .log-body'),
      btn: btn ? (btn.textContent || '').trim() : null,
    }
  })()`)

  check(
    '日志面板默认收起（全新配置的 logCollapsed 是 true）',
    logDefault.setting === true,
    JSON.stringify(logDefault),
  )
  check(
    '收起状态与界面一致：没有日志正文，头部那个按钮写着「展开」',
    logDefault.hasBody === false && logDefault.btn === '展开',
    JSON.stringify(logDefault),
  )

  // 收起时卡片区应该铺满整屏（那才是「不想展开」的收益），拍一张留个记录
  if (SHOT_DIR) {
    await cdp.send('Page.enable')
    await sleep(200)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-log-collapsed.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-log-collapsed.png')
  }

  // 点一下按钮：设置与界面必须同时翻转。只翻一边就是「按钮看起来有用」——
  // 界面上去了但没落盘（下次启动又缩回去），或者落了盘但界面不动。
  const logToggle = await cdp.evaluate(`(async () => {
    const find = () => [...document.querySelectorAll('.log-pane .log-head .btn')]
      .find((b) => ['收起', '展开'].includes((b.textContent || '').trim()))
    const btn = find()
    if (!btn) return { error: '日志头部没有收起/展开按钮' }
    btn.click()
    await new Promise((r) => setTimeout(r, 250))
    const after = find()
    return {
      setting: !!(await window.api.settings.get()).logCollapsed,
      hasBody: !!document.querySelector('.log-pane .log-body'),
      btn: after ? (after.textContent || '').trim() : null,
    }
  })()`)

  check(
    '点「展开」后设置落盘为 false、日志正文出现、按钮变成「收起」',
    !logToggle.error &&
      logToggle.setting === false &&
      logToggle.hasBody === true &&
      logToggle.btn === '收起',
    logToggle.error ?? JSON.stringify(logToggle),
  )

  // --- 7. 日志里的链接：能点，且点击真的走到主进程 -----------------------
  //
  // 三件事缺一条，这功能就只是「长得像链接」：
  //   a) 真实输出里的 URL 被渲染成锚点，且只带 data-url —— 一个真的 href
  //      被点中会把整个应用窗口导航走，界面上就再也回不来了；
  //   b) 头部出现「打开链接」入口（Vite 的地址打在第一屏，之后被输出顶走）；
  //   c) 点击真的过了委派处理器 + IPC 到主进程的白名单。
  //
  // 为什么要专门造一条命令：探针的种子数据只有卡片、没有输出，而链接是在
  // 「渲染日志行」这条路径上生成的 —— 不去真跑一条命令，就只是测了 toHtml。
  // 命令用 `echo` 而不是 `npm run dev`：这条断言要的是「有一行带 URL 的输出」，
  // 起一个真 dev server 只会让探针变慢变脆。
  //
  // (c) 用 file:// 来验，它**必须**被拒：点一个真链接会弹出用户的默认浏览器，
  // 自动化探针不该有这种副作用，而拒绝路径恰好横跨了整条链的每一段。
  const linkSetup = await cdp.evaluate(`(async () => {
    const nodes = await window.api.tree.list()
    const group = nodes.find((n) => n.kind === 'group' && n.path)
    if (!group) return { error: '没有绑定目录的分组' }
    const cmd = await window.api.tree.createCommand({
      parentId: group.id,
      name: '探针URL命令',
      command: 'echo  ready at http://localhost:5199/  mock at http://127.0.0.1:5399/api',
    })
    await window.api.processes.start(cmd.id)
    return { id: cmd.id, name: cmd.name, groupId: group.id }
  })()`)

  // 等它跑完，再把焦点切到它 —— 日志面板只显示当前聚焦命令的输出
  await sleep(2000)
  const focused = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tree-pane .row')]
    const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify('探针URL命令')}))
    if (!row) return { found: false }
    row.click()
    return { found: true }
  })()`)

  let linkDom = { count: 0, url: null, href: null, head: null }
  if (focused.found) {
    for (let i = 0; i < 40; i++) {
      linkDom = await cdp.evaluate(`(() => {
        const all = document.querySelectorAll('.log-pane .viewport a.log-link')
        const first = all[0]
        const head = document.querySelector('.log-pane .link-btn')
        return {
          count: all.length,
          url: first ? first.dataset.url : null,
          href: first ? first.getAttribute('href') : null,
          head: head ? (head.textContent || '').trim() : null,
          text: first ? (first.textContent || '') : null,
          // 一行打两个地址 → 一行两个锚点，所以 count 要除以每行的锚点数才是行数
          lines: document.querySelectorAll('.log-pane .viewport .line').length,
          lineTexts: [...document.querySelectorAll('.log-pane .viewport .line')]
            .map((d) => (d.textContent || '').trim()),
        }
      })()`)
      if (linkDom.count > 0 && linkDom.head) break
      await sleep(250)
    }
  }

  check(
    '真实日志输出里的 URL 被渲染成只带 data-url 的锚点',
    linkDom.count > 0 && linkDom.url === 'http://localhost:5199/' && linkDom.href === null,
    JSON.stringify(linkDom),
  )
  // 头部入口取的是**最近出现**的地址。夹具这行故意打了两个（前端 + mock），
  // 所以这里期望的是行尾那个 —— 仍然只断言「是最近那个」，不锁死具体值。
  check(
    '日志面板头部出现「打开链接」入口，且指向最近打印的地址',
    typeof linkDom.head === 'string' && linkDom.head.includes('127.0.0.1:5399/api'),
    JSON.stringify(linkDom.head),
  )
  // 注意不能断言「只有一行」：启动横幅会把命令行原样打一遍（这行里也含 URL），
  // 结束还会补一条退出提示，所以这个夹具正常就是 3 行。要证的是「没有重复插入」，
  // 即同一段文本不该在缓冲里出现两次。
  check(
    '同一条输出没有被重复插入日志缓冲',
    new Set(linkDom.lineTexts).size === linkDom.lineTexts.length,
    JSON.stringify({ lines: linkDom.lines, lineTexts: linkDom.lineTexts }),
  )

  // 点击链：造一个不在白名单里的链接丢进视口，用真实点击事件走完整条链
  const rejectProbe = await cdp.evaluate(`(async () => {
    const viewport = document.querySelector('.log-pane .viewport')
    if (!viewport) return { error: '日志视口不存在' }
    const a = document.createElement('a')
    a.className = 'log-link'
    a.dataset.url = 'file:///C:/windows/win.ini'
    a.textContent = 'probe-blocked'
    viewport.appendChild(a)
    a.click()
    for (let i = 0; i < 40; i++) {
      const text = document.querySelector('.banner.error .banner-text')
      if (text) {
        const message = (text.textContent || '').trim()
        a.remove()
        return { rejected: true, message }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    a.remove()
    return { rejected: false }
  })()`)

  check(
    '点击链接真的走到主进程白名单（非 http(s) 被拒并回显到界面）',
    rejectProbe.rejected === true && String(rejectProbe.message).includes('只允许打开'),
    JSON.stringify(rejectProbe),
  )

  // 卡片上的「链接」下拉。上面的 echo 故意打了两个不同的地址：一条命令同时暴露
  // 前端和 mock 服务是真实场景，而这时光靠端口胶囊（只能开一个）不够用。
  // 顺带验了去重 —— `http://localhost:5199/`（日志里的原文）与端口派生的
  // `http://localhost:5199`（没有尾斜杠）是同一个地址，列表里必须只出现一次。
  let cardLinks = { hasPill: false, pill: null, items: [], closed: false }
  if (focused.found) {
    // 点开下拉并读回内容。**先不关** —— 下面可能要用它截图，关掉就拍不到了。
    const opened = await cdp.evaluate(`(async () => {
      const card = [...document.querySelectorAll('.card')]
        .find((c) => (c.textContent || '').includes(${JSON.stringify('探针URL命令')}))
      if (!card) return { hasPill: false, error: '找不到卡片' }
      const pill = card.querySelector('.pill.links')
      if (!pill) return { hasPill: false, cardText: (card.textContent || '').trim().slice(0, 160) }
      const pillText = (pill.textContent || '').trim()
      // 卡片是网格里的第 7 张，多半在可视区之外 —— 不先滚进来，下拉会开在
      // 一个看起来和任何按钮都无关的位置（菜单是按 pill 的布局坐标定位的）
      card.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 120))
      pill.click()
      for (let i = 0; i < 40; i++) {
        const items = [...document.querySelectorAll('.menu .menu-item')]
        if (items.length) {
          return {
            hasPill: true,
            pill: pillText,
            items: items.map((b) => ((b.querySelector('.url') || {}).textContent || '').trim()),
          }
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      return { hasPill: true, pill: pillText, items: [] }
    })()`)

    const shotDir = process.env.TM_SHOT_DIR
    if (shotDir && opened.items && opened.items.length) {
      mkdirSync(shotDir, { recursive: true })
      await cdp.send('Page.enable')
      // 定成 dark，截图才可复现（不跟随跑探针这台机器的系统主题）
      await cdp.evaluate(`window.api.settings.update({ theme: 'dark' })`)
      await sleep(250)
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(shotDir, 'ui-card-links.png'), Buffer.from(png.data, 'base64'))
      console.log('[probe] 截图 ui-card-links.png')
    }

    const closed = await cdp.evaluate(`(async () => {
      document.querySelector('.backdrop')?.click()
      await new Promise((r) => setTimeout(r, 60))
      return document.querySelectorAll('.menu').length === 0
    })()`)

    cardLinks = { ...opened, closed }
  }

  check(
    '命令卡片上有「链接」下拉，列出这条命令输出里的所有地址（已去重）',
    cardLinks.hasPill === true &&
      cardLinks.items.length === 2 &&
      cardLinks.items[0] === 'localhost:5199' &&
      cardLinks.items[1] === '127.0.0.1:5399/api',
    JSON.stringify(cardLinks),
  )
  check(
    '下拉选完能关掉（点空白处）',
    cardLinks.closed === true,
    `closed=${cardLinks.closed}`,
  )

  // 收拾干净：临时命令、错误横幅都不能留给后面的断言
  await cdp.evaluate(`(async () => {
    const nodes = await window.api.tree.list()
    const temp = nodes.find((n) => n.name === '探针URL命令')
    if (temp) await window.api.tree.remove(temp.id)
    const close = document.querySelector('.banner.error .btn')
    if (close) close.click()
    return true
  })()`)
  await sleep(300)

  // --- 链接只认被监控进程的真实输出 --------------------------------------
  //
  // terminal-manage 自己的启动横幅会把命令行**原样回显**，于是命令行文本里自带的
  // 地址（`curl http://内网/health`、`vite --host http://…`）会被算成「这条命令
  // 暴露的链接」，用户点开看到一个根本没人监听的地址 —— 比没有链接更误导人。
  //
  // 这条断言就盯这个：命令文本里有 URL、输出里没有 → 卡片上不该有链接下拉。
  // `set VAR=value` 在 cmd 里不打印任何东西，所以输出只有 `banner-check-ok`，
  // 而横幅里那句 `set PROBE_URL=http://127.0.0.1:5999/notes` 是实打实存在的。
  await cdp.evaluate(`(async () => {
    const nodes = await window.api.tree.list()
    const group = nodes.find((n) => n.kind === 'group' && n.path)
    if (!group) return { error: '没有绑定目录的分组' }
    const cmd = await window.api.tree.createCommand({
      parentId: group.id,
      name: '探针BANNER命令',
      command: 'set PROBE_URL=http://127.0.0.1:5999/notes && echo banner-check-ok',
    })
    await window.api.processes.start(cmd.id)
    return { id: cmd.id, name: cmd.name }
  })()`)

  await sleep(2000)
  const bannerProbe = await cdp.evaluate(`(async () => {
    const rows = [...document.querySelectorAll('.tree-pane .row')]
    const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify('探针BANNER命令')}))
    row?.click()
    await new Promise((r) => setTimeout(r, 250))
    const card = [...document.querySelectorAll('.card')]
      .find((c) => (c.textContent || '').includes(${JSON.stringify('探针BANNER命令')}))
    // 逐行读**渲染出来的**日志，而不是 window.api.logs.snapshot()：
    // 后者读的是主进程 LineBuffer，那是子进程输出的缓冲，工具自己插的横幅根本
    // 不在里面（横幅只经过 batcher 直接推给渲染层）。拿它当前提会恒为 false。
    const lineTexts = [...document.querySelectorAll('.log-pane .viewport .line')]
      .map((el) => (el.textContent || '').trim())
    const withUrl = lineTexts.filter((t) => t.includes('127.0.0.1:5999'))
    return {
      // 前提：这个地址确实出现在屏幕上（否则整条断言是空过的）
      logHasUrl: withUrl.length > 0,
      // 而且它只出现在工具自己的那一行里 —— 真实输出没有这个地址
      urlOnlyInMeta:
        withUrl.length > 0 && withUrl.every((t) => t.startsWith('[terminal-manage]')),
      lineCount: lineTexts.length,
      hasPill: card ? !!card.querySelector('.pill.links') : null,
    }
  })()`)

  check(
    '命令行里自带的地址不会被当成链接（引用它的横幅不算输出）',
    bannerProbe.logHasUrl === true &&
      bannerProbe.urlOnlyInMeta === true &&
      bannerProbe.hasPill === false,
    JSON.stringify(bannerProbe),
  )

  await cdp.evaluate(`(async () => {
    const nodes = await window.api.tree.list()
    const temp = nodes.find((n) => n.name === ${JSON.stringify('探针BANNER命令')})
    if (temp) await window.api.tree.remove(temp.id)
    return true
  })()`)
  await sleep(200)

  // --- 8./9. 侧边栏两个入口必须是两个不同的弹窗 --------------------------
  //
  // 「＋项目」要名称 + 路径，「＋分组」只要名称。这两条是**校验**，静态截图
  // 证明不了：弹窗长得对、按钮点下去没反应（校验拦住了但没提示）也照样拍得
  // 出好看的图。所以这里真的点按钮、真的空着提交、读回错误文案。
  //
  // 早先这两个入口共用一个「目录可留空」的弹窗，标题还是靠「用户有没有填
  // 目录」反推 —— 从「＋目录」进来、还没选路径时，标题显示的是「新建分组」。
  const modalProbeSrc = (pickText) => `(async () => {
    const btns = [...document.querySelectorAll('.tree-pane .pane-head .icon-btn')]
    const btn = btns.find((b) => b.textContent.includes(${JSON.stringify(pickText)}))
    if (!btn) return { error: '找不到按钮', buttons: btns.map((b) => b.textContent.trim()) }
    btn.click()
    await new Promise((r) => setTimeout(r, 260))
    const dlg = document.querySelector('.overlay .dialog')
    const title = dlg?.querySelector('h2')?.textContent?.trim() ?? null
    const labels = [...(dlg?.querySelectorAll('.label') ?? [])].map((n) => n.textContent.trim())
    const inputs = dlg ? dlg.querySelectorAll('.input').length : 0
    const parentSel = dlg ? dlg.querySelector('select.input') : null
    const parentDefault = parentSel ? parentSel.value : null
    const submit = [...(dlg?.querySelectorAll('.dlg-foot .btn') ?? [])].find((b) => b.textContent.includes('创建'))
    submit?.click()
    await new Promise((r) => setTimeout(r, 260))
    const err = document.querySelector('.overlay .dialog .err')?.textContent?.trim() ?? null
    const stillOpen = Boolean(document.querySelector('.overlay .dialog'))
    document.querySelector('.overlay .dialog .x')?.click()
    await new Promise((r) => setTimeout(r, 220))
    return { title, labels, inputs, parentDefault, err, stillOpen, closed: !document.querySelector('.overlay .dialog') }
  })()`

  const projModal = await cdp.evaluate(modalProbeSrc('项目'))
  check(
    '「＋项目」打开的是「新建项目」，含所属分组、项目名称、项目路径三个字段',
    projModal.title === '新建项目' &&
      projModal.inputs === 3 &&
      projModal.labels.includes('所属分组') &&
      projModal.labels.includes('项目名称') &&
      projModal.labels.includes('项目路径'),
    JSON.stringify(projModal),
  )
  check(
    '从树上头的「＋项目」进来，所属分组默认是根级',
    projModal.parentDefault === '',
    `parentDefault=${JSON.stringify(projModal.parentDefault)}`,
  )
  check(
    '项目名称与路径都空着提交会被拦下并给出提示（弹窗不关）',
    projModal.err === '请填项目名称' && projModal.stillOpen === true,
    `err=${JSON.stringify(projModal.err)} stillOpen=${projModal.stillOpen}`,
  )
  check('提交被拦下后弹窗可以正常关闭', projModal.closed === true, `closed=${projModal.closed}`)

  const groupModal = await cdp.evaluate(modalProbeSrc('分组'))
  check(
    '「＋分组」打开的是「新建分组」，只有所属分组与名称两个字段、没有路径',
    groupModal.title === '新建分组' &&
      groupModal.inputs === 2 &&
      groupModal.labels.length === 2 &&
      groupModal.labels[0] === '所属分组' &&
      groupModal.labels[1] === '分组名称',
    JSON.stringify(groupModal),
  )
  check(
    '分组名称为空提交会被拦下并给出提示',
    groupModal.err === '请填分组名称' && groupModal.stillOpen === true,
    `err=${JSON.stringify(groupModal.err)}`,
  )

  // --- 9b. 「所属分组」下拉框：新建时能自己挑挂在哪个分组下 ----------------
  //
  // 父级原先完全由入口决定（树上头点「＋项目」＝根级，右键某个分组才有子级），
  // 而这件事只写在右键菜单里 —— 想建到某个分组下就得先猜到要右键它。现在摊到
  // 弹窗里，下面两条钉的就是它，顺带盯住两个很容易漏的坑：
  //   1) 候选里必须有**折叠着的**分组。折叠的分组不在 treeRows 里（那是给树渲染
  //      用的），候选要是从 treeRows 过滤出来，用户就会遇到「我明明有这个分组，
  //      下拉框里却没有」。
  //   2) 挑好父级、点了创建，树上必须立刻看得见新节点 —— 否则界面纹丝不动，用户
  //      只会以为没建成、再点一次。
  const pickerFix = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const list = await window.api.tree.list()
    const host = list.find((n) => n.id === ${JSON.stringify(seedSiblings[0].id)})
    const target = await window.api.tree.createGroup({
      parentId: ${JSON.stringify(seedRoot.id)}, name: '探针父级靶', path: host.path,
    })
    const inner = await window.api.tree.createGroup({
      parentId: target.id, name: '探针父级靶子', path: host.path,
    })
    // 两层都收起来 —— 「选得到折叠的分组」正是要证明的
    await window.api.tree.update({ id: target.id, expanded: false })
    await sleep(500)
    return { targetId: target.id, innerId: inner.id }
  })()`)

  const pickerProbe = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('.tree-pane .pane-head .icon-btn')]
      .find((b) => b.textContent.includes('分组'))
    btn.click()
    await sleep(300)

    const dlg = document.querySelector('.overlay .dialog')
    const sel = dlg.querySelector('select.input')
    const 默认值 = sel.value
    const 候选值 = [...sel.options].map((o) => o.value)
    const 选项文本 = [...sel.options].map((o) => o.textContent.trim())
    const 全部分组 = (await window.api.tree.list()).filter((n) => n.kind === 'group').map((n) => n.id)
    // 此刻树上渲染不出来的分组（折叠的父级下面的那些）
    const 树上看不见的 = 全部分组.filter(
      (id) => !document.querySelector('.tree-pane .row[data-id="' + id + '"]'),
    )
    const 靶子选项 = [...sel.options].find((o) => o.value === ${JSON.stringify(pickerFix.innerId)})
    // 刻意不 trim：缩进用的是全角空格 U+3000，而它恰好属于 trim 会吃掉的那类空白
    const 靶子缩进 = 靶子选项 ? 靶子选项.textContent : null

    sel.value = ${JSON.stringify(pickerFix.innerId)}
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    const 名称框 = dlg.querySelector('.dlg-body input.input')
    名称框.value = '探针父级落地'
    名称框.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(180)
    dlg.querySelector('.dlg-foot .btn:last-child').click()
    await sleep(1000)

    const 新节点 = (await window.api.tree.list()).find((n) => n.name === '探针父级落地') ?? null
    return {
      默认值, 候选值, 选项文本, 全部分组, 树上看不见的, 靶子缩进,
      落地父级: 新节点 ? 新节点.parentId : null,
      期望父级: ${JSON.stringify(pickerFix.innerId)},
      建完就看得见: 新节点
        ? Boolean(document.querySelector('.tree-pane .row[data-id="' + 新节点.id + '"]'))
        : false,
      弹窗关了: !document.querySelector('.overlay .dialog'),
    }
  })()`)
  check(
    '候选分组一个不缺（含折叠着的那些），首项是根级，子分组按层级缩进',
    pickerProbe.候选值.length === pickerProbe.全部分组.length + 1 &&
      pickerProbe.候选值[0] === '' &&
      pickerProbe.树上看不见的.length > 0 &&
      pickerProbe.树上看不见的.every((id) => pickerProbe.候选值.includes(id)) &&
      typeof pickerProbe.靶子缩进 === 'string' &&
      pickerProbe.靶子缩进.startsWith('　'),
    JSON.stringify({
      候选数: pickerProbe.候选值.length,
      分组数: pickerProbe.全部分组.length,
      树上看不见的: pickerProbe.树上看不见的.length,
      靶子缩进: pickerProbe.靶子缩进,
    }),
  )
  check(
    '在弹窗里挑一个折叠的分组当父级，新分组真的建在它下面、且建完立刻看得见',
    pickerProbe.默认值 === '' &&
      pickerProbe.落地父级 === pickerProbe.期望父级 &&
      pickerProbe.建完就看得见 === true &&
      pickerProbe.弹窗关了 === true,
    JSON.stringify({
      默认值: pickerProbe.默认值,
      落地父级: pickerProbe.落地父级,
      期望父级: pickerProbe.期望父级,
      建完就看得见: pickerProbe.建完就看得见,
      弹窗关了: pickerProbe.弹窗关了,
    }),
  )

  // 「新建项目」走的是另一条分支（importDir 而不是 createGroup），所以父级得单独
  // 再验一遍。用户原话问的正是项目这条路。
  const projPickerProbe = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const host = (await window.api.tree.list()).find((n) => n.id === ${JSON.stringify(seedSiblings[0].id)})
    const 靶 = await window.api.tree.createGroup({
      parentId: ${JSON.stringify(seedRoot.id)}, name: '探针父级项目靶', path: host.path,
    })
    await window.api.tree.update({ id: 靶.id, expanded: false })
    await sleep(400)

    const btn = [...document.querySelectorAll('.tree-pane .pane-head .icon-btn')]
      .find((b) => b.textContent.includes('项目'))
    btn.click()
    await sleep(300)
    const dlg = document.querySelector('.overlay .dialog')
    const sel = dlg.querySelector('select.input')
    const 选中生效 = (() => {
      sel.value = 靶.id
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return sel.value === 靶.id
    })()

    const inputs = [...dlg.querySelectorAll('.dlg-body input.input')]
    const 名称框 = inputs[0]
    名称框.value = '探针父级项目'
    名称框.dispatchEvent(new Event('input', { bubbles: true }))
    const 路径框 = inputs[1]
    路径框.value = ${JSON.stringify(process.cwd())}
    路径框.dispatchEvent(new Event('input', { bubbles: true }))
    // 两个勾都取消：跳过导入 scripts，免得建出一堆卡片再删一遍
    for (const box of dlg.querySelectorAll('.check input[type=checkbox]')) {
      if (box.checked) box.click()
    }
    await sleep(200)
    dlg.querySelector('.dlg-foot .btn:last-child').click()
    await sleep(1800)

    const 新节点 = (await window.api.tree.list()).find((n) => n.name === '探针父级项目') ?? null
    const res = {
      选中生效,
      落地父级: 新节点 ? 新节点.parentId : null,
      期望父级: 靶.id,
      绑到了目录: 新节点 ? 新节点.path === ${JSON.stringify(process.cwd())} : false,
      弹窗关了: !document.querySelector('.overlay .dialog'),
    }
    await window.api.tree.remove(靶.id)
    await sleep(600)
    // 只数本探针自己的名字：上面那套「探针父级靶」正挂在树上等着后一条清理断言，
    // 两套混在一起数，这条就会替别人背锅
    res.残留 = (await window.api.tree.list()).filter((n) => n.name.indexOf('探针父级项目') === 0).length
    return res
  })()`)
  check(
    '「新建项目」也能挑父级：项目真的建在选中的那个分组下，且带上了自己的目录',
    projPickerProbe.选中生效 === true &&
      projPickerProbe.落地父级 === projPickerProbe.期望父级 &&
      projPickerProbe.绑到了目录 === true &&
      projPickerProbe.弹窗关了 === true,
    JSON.stringify(projPickerProbe),
  )

  const pickerClean = await cdp.evaluate(`(async () => {
    await window.api.tree.remove(${JSON.stringify(pickerFix.targetId)})
    await new Promise((r) => setTimeout(r, 600))
    return (await window.api.tree.list()).filter((n) => n.name.indexOf('探针父级') === 0).length
  })()`)
  check(
    '探针建的父级夹具已收拾干净',
    pickerClean === 0 && projPickerProbe.残留 === 0,
    `残留 ${pickerClean} / ${projPickerProbe.残留}`,
  )

  // --- 可选：把两个弹窗拍下来 ---------------------------------------------
  //
  // 断言证明得了「标题是新建项目、字段是两个、空提交被拦下」，但证明不了它
  // 长得好不好看。设了 TM_SHOT_DIR 就顺手拍两张 —— SHOT_DIR 本身声明在文件顶部。
  if (SHOT_DIR) {
    mkdirSync(SHOT_DIR, { recursive: true })
    await cdp.send('Page.enable')
    // 定成 dark，截图才可复现（不跟随跑探针这台机器的系统主题）
    await cdp.evaluate(`window.api.settings.update({ theme: 'dark' })`)
    await sleep(300)

    const shot = async (file, pickText) => {
      await cdp.evaluate(`(async () => {
        const btn = [...document.querySelectorAll('.tree-pane .pane-head .icon-btn')]
          .find((b) => b.textContent.includes(${JSON.stringify(pickText)}))
        btn?.click()
        await new Promise((r) => setTimeout(r, 320))
      })()`)
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOT_DIR, file), Buffer.from(png.data, 'base64'))
      console.log(`[probe] 截图 ${file}`)
      await cdp.evaluate(`document.querySelector('.overlay .dialog .x')?.click()`)
      await sleep(220)
    }

    await shot('ui-new-project.png', '项目')
    await shot('ui-new-group.png', '分组')
  }

  // --- 10. 落盘：该存的存了、不该存的没存 --------------------------------
  //
  // 用 Node 读盘而不是 PowerShell —— PS 5.1 的 Get-Content 默认按 ANSI 解码，
  // 读 UTF-8 的中文会变乱码，`-match '探针改名OK'` 必然为 false，
  // 会把「已经存好了」误判成「没落盘」。
  const saved = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf-8') : ''
  check('重命名已落盘到 config.json', saved.includes('探针改名OK'), 'Enter 的结果应在磁盘上')
  check('Esc 的草稿没有落盘', !saved.includes('不该被保存的名字'), '取消不该写盘')

  // --- 11. 「移动到…」：菜单要原地换成目标列表，选中目标要真的搬走 ---------
  //
  // 修过的缺陷：菜单项统一走 act()（先 emit('close') 再执行 run），而父组件是
  // `v-if="menu"` —— 整个 NodeMenu 在 movePickerOpen = true 生效前就被销毁了，
  // 于是点「移动到…」界面毫无反应。截图看不出来（菜单本来就画得对）、也没有
  // 任何报错，正是这个探针存在的理由：只有真点一次才发现得了。
  const [groupA, groupB] = seedSiblings
  const moveProbe = await cdp.evaluate(`(async () => {
    void (await window.api.tree.createCommand({
      parentId: ${JSON.stringify(groupA.id)},
      name: ${JSON.stringify('探针MOVE命令')},
      command: 'echo move-me',
    }))
    await new Promise((r) => setTimeout(r, 300))

    const rows = () => [...document.querySelectorAll('.tree-pane .row')]
    const texts = () => rows().map((r) => (r.textContent || '').trim())
    const before = texts()
    const beforeIdx = before.findIndex((t) => t.includes(${JSON.stringify('探针MOVE命令')}))
    const beforeTargetIdx = before.findIndex((t) => t.includes(${JSON.stringify(groupB.name)}))

    const row = rows().find((r) => (r.textContent || '').includes(${JSON.stringify('探针MOVE命令')}))
    if (!row) return { error: '找不到探针MOVE命令行' }
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 260 }))
    await new Promise((r) => setTimeout(r, 240))

    const moveItem = [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => (b.textContent || '').trim() === '移动到…')
    if (!moveItem) return { error: '菜单里没有「移动到…」' }
    moveItem.click()
    await new Promise((r) => setTimeout(r, 240))

    // 缺陷就在这里暴露：菜单被 act() 关掉的话，下面这两项都会是空的
    const title = document.querySelector('.menu .menu-title')?.textContent ?? null
    const buttons = [...document.querySelectorAll('.menu .menu-scroll .menu-item')]
    const targetLabels = buttons.map((b) => (b.textContent || '').trim())

    const pick = buttons.find((b) => (b.textContent || '').trim() === ${JSON.stringify(groupB.name)})
    if (!pick) return { title, targetLabels, picked: null, beforeIdx, beforeTargetIdx }

    pick.click()
    await new Promise((r) => setTimeout(r, 900))

    const after = texts()
    const result = {
      title,
      targetLabels,
      picked: ${JSON.stringify(groupB.name)},
      beforeIdx,
      beforeTargetIdx,
      afterIdx: after.findIndex((t) => t.includes(${JSON.stringify('探针MOVE命令')})),
      targetIdx: after.findIndex((t) => t.includes(${JSON.stringify(groupB.name)})),
      stillOpen: document.querySelectorAll('.menu').length > 0,
    }
    // 收拾干净：这条命令是探针自己建的，不该留在 profile 里
    const list = await window.api.tree.list()
    const temp = list.find((n) => n.name === ${JSON.stringify('探针MOVE命令')})
    if (temp) await window.api.tree.remove(temp.id)
    return result
  })()`)

  check(
    '「移动到…」把菜单原地换成了目标列表（不会被自己关掉）',
    typeof moveProbe.title === 'string' &&
      moveProbe.title.includes('移动到…') &&
      (moveProbe.targetLabels || []).length > 0,
    JSON.stringify({ title: moveProbe.title, targets: moveProbe.targetLabels, error: moveProbe.error }),
  )
  check(
    '选一个目标后命令真的搬到了那个分组下面',
    moveProbe.picked != null &&
      moveProbe.beforeIdx >= 0 &&
      moveProbe.beforeIdx < moveProbe.beforeTargetIdx &&
      moveProbe.afterIdx > moveProbe.targetIdx,
    JSON.stringify({
      picked: moveProbe.picked,
      搬之前: `${moveProbe.beforeIdx} 在目标 ${moveProbe.beforeTargetIdx} 之上`,
      搬之后: `${moveProbe.afterIdx} 在目标 ${moveProbe.targetIdx} 之下`,
    }),
  )
  check('搬完菜单关掉了', moveProbe.stillOpen === false, `stillOpen=${moveProbe.stillOpen}`)

  // --- 11b. 左树归属感：参考线、对齐、分组底色、祖先提亮 -------------------
  //
  // 用户的原话是「左侧菜单栏结构树不是太明显」。这类「不明显」最阴的坏法是：
  // CSS 变量名写错、`v-for` 少渲染一层线、flex 里的盒子宽度变了 —— 截图上看着
  // 差不多，实际上归属感又塌回原样。所以这里一条都不看类名，全读**真实计算样式
  // 与真实几何**：线的条数与横坐标、同层标签的左边缘、分组与命令的底色差。
  const dragFix = await cdp.evaluate(`(async () => {
    const list = await window.api.tree.list()
    const root = list.find((n) => n.id === ${JSON.stringify(seedRoot.id)})
    const host = list.find((n) => n.id === ${JSON.stringify(groupA.id)})
    // 命令只能落进「能解析出项目目录」的分组，所以宿主分组照抄 groupA 的 path
    const dragHost = await window.api.tree.createGroup({
      parentId: root.id, name: '探针DRAG宿主', path: host.path,
    })
    const dragSub = await window.api.tree.createGroup({
      parentId: dragHost.id, name: '探针DRAG子分组', path: host.path,
    })
    const cmd = await window.api.tree.createCommand({
      parentId: host.id, name: '探针DRAG命令', command: 'echo drag-me',
    })
    // 分组默认展开与否由主进程决定，这里显式掰开，免得断言依赖那个默认值
    await window.api.tree.update({ id: root.id, expanded: true })
    await window.api.tree.update({ id: host.id, expanded: true })
    await window.api.tree.update({ id: dragHost.id, expanded: true })
    await new Promise((r) => setTimeout(r, 500))
    return {
      rootId: root.id, hostId: host.id, hostName: host.name,
      dragHostId: dragHost.id, dragSubId: dragSub.id, cmdId: cmd.id,
    }
  })()`)

  const treeVisual = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tree-pane .row')]
    const INDENT_BASE = 6
    const INDENT_STEP = 14
    const geom = rows.map((r) => {
      const pl = parseFloat(getComputedStyle(r).paddingLeft)
      const depth = Math.round((pl - INDENT_BASE) / INDENT_STEP)
      const rails = [...r.querySelectorAll('.rail')]
      const base = r.getBoundingClientRect().left
      return {
        depth,
        pl,
        rails: rails.length,
        // 第 i 层参考线应当正好落在该层折叠箭头中心：INDENT_BASE + i*INDENT_STEP + 箭头半宽 8
        aligned: rails.every(
          (x, i) => Math.abs(x.getBoundingClientRect().left - (base + 14 + i * INDENT_STEP)) < 1.5,
        ),
      }
    })
    const cs = (el) => getComputedStyle(el)
    // 顶层分组是 600、子分组是 500，取「子分组」时必须排掉 root，否则两条断言
    // 其实在量同一行、永远自洽地骗过检查
    const groupRow = rows.find((r) => r.classList.contains('group') && !r.classList.contains('root'))
    const cmdRow = rows.find((r) => r.classList.contains('command'))
    const rootGroup = rows.find((r) => r.classList.contains('group') && r.classList.contains('root'))
    return {
      行数: rows.length,
      最大深度: Math.max(...geom.map((g) => g.depth)),
      线条数与深度对不上的行: geom.filter((g) => g.rails !== g.depth).length,
      线位置偏了的行: geom.filter((g) => !g.aligned).length,
      分组底色: cs(groupRow).backgroundColor,
      命令底色: cs(cmdRow).backgroundColor,
      顶层分组字重: cs(rootGroup).fontWeight,
      子分组字重: cs(groupRow).fontWeight,
      命令字重: cs(cmdRow).fontWeight,
    }
  })()`)

  check(
    '每一层都有归属参考线，且线的条数正好等于该行的深度',
    treeVisual.最大深度 >= 2 && treeVisual.线条数与深度对不上的行 === 0,
    JSON.stringify(treeVisual),
  )
  check(
    '参考线的横坐标正好落在该层折叠箭头的中心（上层箭头竖直垂下来）',
    treeVisual.线位置偏了的行 === 0,
    `偏了 ${treeVisual.线位置偏了的行} 行`,
  )
  check(
    '分组行有独立底色带，与命令行一眼可分；顶层分组再重一档字重',
    treeVisual.分组底色 !== treeVisual.命令底色 &&
      treeVisual.顶层分组字重 === '600' &&
      treeVisual.子分组字重 === '500' &&
      treeVisual.命令字重 === '400',
    JSON.stringify({
      分组底色: treeVisual.分组底色,
      命令底色: treeVisual.命令底色,
      字重: [treeVisual.顶层分组字重, treeVisual.子分组字重, treeVisual.命令字重],
    }),
  )

  // 同层标签必须严格对齐。原来分组用 12px 的箭头盒、命令用 7px 的圆点，同层
  // 差 5px，纵向扫下来是斜的 —— 这正是「看不出来谁属于谁」的一半原因。
  const alignProbe = await cdp.evaluate(`(() => {
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const left = (id) => rowOf(id)?.querySelector('.label')?.getBoundingClientRect().left ?? null
    return {
      分组: left(${JSON.stringify(dragFix.dragSubId)}),
      命令: left(${JSON.stringify(dragFix.cmdId)}),
      分组行数据: rowOf(${JSON.stringify(dragFix.dragSubId)})?.getBoundingClientRect().left ?? null,
      命令行数据: rowOf(${JSON.stringify(dragFix.cmdId)})?.getBoundingClientRect().left ?? null,
    }
  })()`)
  check(
    '同一深度的分组标签与命令标签左边缘严格对齐（状态点与箭头等宽）',
    alignProbe.分组 != null &&
      alignProbe.命令 != null &&
      alignProbe.分组行数据 === alignProbe.命令行数据 &&
      Math.abs(alignProbe.分组 - alignProbe.命令) < 1,
    JSON.stringify(alignProbe),
  )

  const hoverProbe = await cdp.evaluate(`(async () => {
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const cmd = rowOf(${JSON.stringify(dragFix.cmdId)})
    if (!cmd) return { error: '找不到命令行' }
    cmd.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((r) => setTimeout(r, 150))
    const lit = [...document.querySelectorAll('.tree-pane .row.ancestor')].map((r) => r.dataset.id)
    const litBg = lit.length ? getComputedStyle(rowOf(lit[0])).backgroundColor : null
    const plain = [...document.querySelectorAll('.tree-pane .row.group:not(.ancestor)')][0]
    const plainBg = plain ? getComputedStyle(plain).backgroundColor : null
    const litLabel = lit.length ? getComputedStyle(rowOf(lit[0]).querySelector('.label')).color : null
    cmd.dispatchEvent(new MouseEvent('mouseleave'))
    await new Promise((r) => setTimeout(r, 150))
    return {
      lit, litBg, plainBg, litLabel,
      after: document.querySelectorAll('.tree-pane .row.ancestor').length,
      expectHost: ${JSON.stringify(dragFix.hostId)},
      expectRoot: ${JSON.stringify(dragFix.rootId)},
    }
  })()`)
  check(
    '悬停一条命令时，它整条祖先链一起提亮 —— 「这条属于谁」不用再顺着线往上数',
    hoverProbe.lit?.length === 2 &&
      hoverProbe.lit.includes(hoverProbe.expectHost) &&
      hoverProbe.lit.includes(hoverProbe.expectRoot) &&
      hoverProbe.litBg !== hoverProbe.plainBg &&
      hoverProbe.after === 0,
    JSON.stringify(hoverProbe),
  )

  // --- 11c. 拖拽改变归属 ---------------------------------------------------
  //
  // 原生 HTML5 拖放是可以被合成的：我们的处理函数只读 event.currentTarget 的几何、
  // event.clientY 和 dataTransfer，不依赖浏览器内部的拖拽状态，所以 dispatchEvent
  // 出的一串 dragstart / dragover / drop 会完整穿过真实的那套逻辑。
  //
  // 关键断言是 over.defaultPrevented：非法落点**故意不调 preventDefault** —— 那正是
  // 浏览器画禁止光标、并且不再派发 drop 的开关。只看界面有没有画红线是不够的，
  // 那可能是个「看着不让放、松手照样挪」的假拦截。
  const dragProbe = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const src = rowOf(${JSON.stringify(dragFix.cmdId)})
    const dst = rowOf(${JSON.stringify(dragFix.dragHostId)})
    if (!src || !dst) return { error: '找不到拖拽源或目标行' }

    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(90)
    const 拖拽中提示 = document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null
    const 头部按钮数 = document.querySelectorAll('.tree-pane .pane-head .icon-btn').length
    const 跟着走的行 = [...document.querySelectorAll('.tree-pane .row.doomed')].map((r) => r.dataset.id)

    const rect = dst.getBoundingClientRect()
    const cx = rect.left + 70
    const cy = rect.top + rect.height / 2
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy,
    })
    dst.dispatchEvent(over)
    await sleep(80)
    const 放进分组高亮 = document.querySelector('.tree-pane .row.drop-into')?.dataset.id ?? null

    const 放下前标记还在 = document.querySelector('.tree-pane .row.drop-into')?.dataset.id ?? null
    dst.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy,
    }))
    await sleep(900)
    const 第一次父级 = (await window.api.tree.list()).find((n) => n.id === ${JSON.stringify(dragFix.cmdId)})?.parentId ?? null
    const 所有横幅 = [...document.querySelectorAll('.banner')].map((b) => b.className + ' :: ' + b.textContent.trim())

    return {
      拖拽中提示, 头部按钮数, 跟着走的行,
      允许放下: over.defaultPrevented,
      放进分组高亮, 放下前标记还在,
      落点后的父级: 第一次父级,
      期望父级: ${JSON.stringify(dragFix.dragHostId)},
      拖完还有没有残留的提示: document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null,
      拖完残留的落点标记: document.querySelectorAll(
        '.tree-pane .row.drop-into, .tree-pane .row.drop-before, .tree-pane .row.drop-after, .tree-pane .row.drop-bad',
      ).length,
      所有横幅,
    }
  })()`)

  // 落点参数要跨 IPC 才能落盘，而「传了个 Proxy 过去」这类的失败**不抛 JS 异常**：
  // 它只是让 invoke 返回一个被 reject 的 Promise，最后变成一条 state.error 横幅。
  // 光看 DOM 是查不出来的（提示线照样画得完全正确），所以在这里单独钉一条。
  check(
    '拖拽全程没有未捕获异常，也没有在横幅里留下错误',
    cdp.exceptions.length === 0 && !dragProbe.所有横幅.some((b) => b.startsWith('banner error')),
    JSON.stringify({ 异常: cdp.exceptions, 横幅: dragProbe.所有横幅 }),
  )

  check(
    '把命令拖到分组行中间，行真的落进了那个分组（且锚点是一次合法的 preventDefault）',
    dragProbe.允许放下 === true &&
      dragProbe.放进分组高亮 === dragFix.dragHostId &&
      dragProbe.落点后的父级 === dragProbe.期望父级,
    JSON.stringify(dragProbe),
  )
  check(
    '拖拽期间头部换成提示条、被拖的整块显灰，松手后两者都收干净',
    dragProbe.头部按钮数 === 0 &&
      typeof dragProbe.拖拽中提示 === 'string' &&
      (dragProbe.跟着走的行 || []).includes(dragFix.cmdId) &&
      dragProbe.拖完还有没有残留的提示 === null &&
      dragProbe.拖完残留的落点标记 === 0,
    JSON.stringify({
      头部按钮数: dragProbe.头部按钮数,
      拖拽中提示: dragProbe.拖拽中提示,
      跟着走的行: dragProbe.跟着走的行,
      残留提示: dragProbe.拖完还有没有残留的提示,
      残留标记: dragProbe.拖完残留的落点标记,
    }),
  )

  // 命令挂到根级就再也解析不出 cwd，会变成一张按不动「启动」的废卡片 —— 主进程
  // 的 resolveSpec 那时只会抛「所属的分组没有绑定项目目录」。这条断言盯的就是
  // 「拖到列表下方空白 = 移到根级」那个入口有没有把命令放过去。
  const rejectRoot = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const src = rowOf(${JSON.stringify(dragFix.cmdId)})
    const body = document.querySelector('.tree-pane .tree-body')
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(80)
    const r = body.getBoundingClientRect()
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: r.left + 70, clientY: r.bottom - 3,
    })
    body.dispatchEvent(over)
    await sleep(80)
    const res = {
      允许放下: over.defaultPrevented,
      提示: document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null,
      标红的行: document.querySelector('.tree-pane .row.drop-bad')?.dataset.id ?? null,
    }
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(120)
    res.松手后提示 = document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null
    return res
  })()`)
  check(
    '命令拖到根级空白被拦下：不 preventDefault（浏览器画禁止光标）并给出原因',
    rejectRoot.允许放下 === false &&
      typeof rejectRoot.提示 === 'string' &&
      rejectRoot.提示.includes('命令只能放进分组') &&
      rejectRoot.标红的行 != null &&
      rejectRoot.松手后提示 === null,
    JSON.stringify(rejectRoot),
  )

  const rejectSelf = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const src = rowOf(${JSON.stringify(dragFix.dragHostId)})
    const dst = rowOf(${JSON.stringify(dragFix.dragSubId)})
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(80)
    const 跟着走的行 = [...document.querySelectorAll('.tree-pane .row.doomed')].map((r) => r.dataset.id)
    const rect = dst.getBoundingClientRect()
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: rect.left + 70, clientY: rect.top + rect.height / 2,
    })
    dst.dispatchEvent(over)
    await sleep(80)
    const res = {
      跟着走的行,
      允许放下: over.defaultPrevented,
      提示: document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null,
      标红: document.querySelectorAll('.tree-pane .row.drop-bad').length,
      自己: ${JSON.stringify(dragFix.dragHostId)},
      自己的子分组: ${JSON.stringify(dragFix.dragSubId)},
    }
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(120)
    return res
  })()`)
  check(
    '把分组拖到它自己的子分组上被拦下，且整棵子树都算「跟着走」',
    rejectSelf.允许放下 === false &&
      rejectSelf.跟着走的行.includes(rejectSelf.自己) &&
      rejectSelf.跟着走的行.includes(rejectSelf.自己的子分组) &&
      rejectSelf.标红 === 1 &&
      typeof rejectSelf.提示 === 'string' &&
      rejectSelf.提示.includes('不能移动到自己的子级里'),
    JSON.stringify(rejectSelf),
  )

  // 用户要的第二件事就是「拖动改变**组之间**的归属关系」，而前面几条量的都是命令。
  // 分组和命令在落点规则上并不一样（分组不受「父级必须能解析出项目目录」那条拦截），
  // 所以这条得单独钉：把子分组整个拖进另一个分组，父级要真的换掉。测完再搬回去，
  // 否则收尾时删 dragHost 带不走它，夹具就会留下「探针DRAG」残骸。
  const moveGroupProbe = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const src = rowOf(${JSON.stringify(dragFix.dragSubId)})
    const dst = rowOf(${JSON.stringify(dragFix.hostId)})
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(80)
    const rect = dst.getBoundingClientRect()
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: rect.left + 70, clientY: rect.top + rect.height / 2,
    })
    dst.dispatchEvent(over)
    await sleep(80)
    const 允许放下 = over.defaultPrevented
    const 描边 = document.querySelector('.tree-pane .row.drop-into')?.dataset.id ?? null
    dst.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: rect.left + 70, clientY: rect.top + rect.height / 2,
    }))
    await sleep(900)
    const 落点后的父级 = (await window.api.tree.list())
      .find((n) => n.id === ${JSON.stringify(dragFix.dragSubId)})?.parentId ?? null
    const 搬回原地 = (await window.api.tree.move({
      id: ${JSON.stringify(dragFix.dragSubId)},
      newParentId: ${JSON.stringify(dragFix.dragHostId)},
      index: 9999,
    })) === true
    return {
      允许放下, 描边, 落点后的父级,
      期望父级: ${JSON.stringify(dragFix.hostId)},
      搬回原地,
    }
  })()`)
  check(
    '把分组拖进另一个分组，父级真的换了，且搬得回来',
    moveGroupProbe.允许放下 === true &&
      moveGroupProbe.描边 === moveGroupProbe.期望父级 &&
      moveGroupProbe.落点后的父级 === moveGroupProbe.期望父级 &&
      moveGroupProbe.搬回原地 === true,
    JSON.stringify(moveGroupProbe),
  )

  // 提示线永远不许撒谎：展开的分组行下沿那条线，语义上是「插到它后面」，而它后面
  // 紧跟的是自己的第一个子节点，真正的落点在整棵子树之后。线必须顺延到子树末尾。
  const markerProbe = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
    const src = rowOf(${JSON.stringify(dragFix.cmdId)})
    const grp = rowOf(${JSON.stringify(dragFix.dragHostId)})
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(80)
    const r = grp.getBoundingClientRect()
    const at = async (y) => {
      const over = new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 70, clientY: y,
      })
      grp.dispatchEvent(over)
      await sleep(70)
      return {
        放下: over.defaultPrevented,
        提示: document.querySelector('.tree-pane .drag-hint')?.textContent?.trim() ?? null,
        线: [...document.querySelectorAll('.tree-pane .row.drop-after')].map((x) => x.dataset.id),
        线在上沿: [...document.querySelectorAll('.tree-pane .row.drop-before')].map((x) => x.dataset.id),
        描边: [...document.querySelectorAll('.tree-pane .row.drop-into')].map((x) => x.dataset.id),
      }
    }
    const 上沿 = await at(r.top + 2)
    const 中间 = await at(r.top + r.height / 2)
    const 下沿 = await at(r.bottom - 2)
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await sleep(120)
    return {
      上沿, 中间, 下沿,
      分组自己: ${JSON.stringify(dragFix.dragHostId)},
      子树最后一行: ${JSON.stringify(dragFix.dragSubId)},
    }
  })()`)
  check(
    '三段式落点分得开：上沿插到前面、中间放进分组、下沿插到后面',
    markerProbe.上沿.线在上沿.length === 1 &&
      markerProbe.上沿.线在上沿[0] === dragFix.dragHostId &&
      markerProbe.中间.描边.length === 1 &&
      markerProbe.中间.描边[0] === dragFix.dragHostId &&
      markerProbe.下沿.线.length === 1,
    JSON.stringify(markerProbe),
  )
  check(
    '展开的分组下沿那条线顺延到了子树末尾（线不撒谎），且该落点因根级没绑目录被如实拦下',
    // 「插到 dragHost 后面」＝插进根级，而根级分组没有 path —— 命令放进去就再也
    // 解析不出 cwd。所以这里正确的表现是：线诚实地画在子树末尾，同时拦下这一放。
    markerProbe.下沿.线[0] === markerProbe.子树最后一行 &&
      !markerProbe.下沿.线.includes(markerProbe.分组自己) &&
      markerProbe.下沿.放下 === false &&
      typeof markerProbe.下沿.提示 === 'string' &&
      markerProbe.下沿.提示.includes('没有绑定项目目录'),
    JSON.stringify(markerProbe.下沿),
  )

  // 拖到一半就截图：这是这次改造唯一无法靠断言说清的东西（线、底色带、描边、
  // 显灰的整块子树）。放在断言之后、清理之前，界面正处于「拖拽进行中」。
  if (process.env.TM_SHOT_DIR) {
    await cdp.send('Page.enable')
    await cdp.evaluate(`window.api.settings.update({ theme: 'dark' })`)
    await sleep(250)
    await cdp.evaluate(`(async () => {
      const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
      const src = rowOf(${JSON.stringify(dragFix.cmdId)})
      const dst = rowOf(${JSON.stringify(dragFix.hostId)})
      window.__probeDt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: window.__probeDt,
      }))
      await new Promise((r) => setTimeout(r, 120))
      const rect = dst.getBoundingClientRect()
      dst.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: window.__probeDt,
        clientX: rect.left + 70, clientY: rect.top + rect.height / 2,
      }))
      await new Promise((r) => setTimeout(r, 260))
    })()`)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-tree-drag.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-tree-drag.png')
    await cdp.evaluate(`(() => {
      const rowOf = (id) => document.querySelector('.tree-pane .row[data-id="' + id + '"]')
      rowOf(${JSON.stringify(dragFix.cmdId)})?.dispatchEvent(new DragEvent('dragend', {
        bubbles: true, cancelable: true, dataTransfer: window.__probeDt,
      }))
    })()`)
    await sleep(200)
  }

  // 探针自己建的宿主分组（连同搬进去的命令、子分组）一起收拾掉
  const dragLeft = await cdp.evaluate(`(async () => {
    await window.api.tree.remove(${JSON.stringify(dragFix.dragHostId)})
    await window.api.tree.remove(${JSON.stringify(dragFix.cmdId)})
    await new Promise((r) => setTimeout(r, 400))
    const list = await window.api.tree.list()
    return list.filter((n) => n.name.includes('探针DRAG')).length
  })()`)
  check('探针建的拖拽夹具已收拾干净', dragLeft === 0, `残留 ${dragLeft}`)

  // --- 12. 运行中的卡片必须整张换底色 -------------------------------------
  //
  // 只把那个 8px 的状态点变绿，一屏十几张卡片时根本看不出哪个在跑。这条断言
  // 读的是真实计算样式 —— CSS 变量名写错、或者类名根本没绑上，都会立刻暴露。
  //
  // 用 spike/fixture/alive.mjs 而不是 `node -e "setInterval(...)"`：后者要穿过
  // cmd.exe 的两层引号解析，引号一被吃掉就变成语法错误、node 立刻退出，卡片停在
  // exited，断言就误报成「底色没变」。第一版正是这么错的，所以现在连 cls 与
  // 状态胶囊文案一起读回来，失败时能一眼看出是「没染上」还是「压根没跑起来」。
  const runProbe = await cdp.evaluate(`(async () => {
    // 先选中 groupA，卡片网格才会渲染它的命令
    const rowOf = (t) => [...document.querySelectorAll('.tree-pane .row')]
      .find((r) => (r.textContent || '').includes(t))
    rowOf(${JSON.stringify(groupA.name)})?.click()
    await new Promise((r) => setTimeout(r, 400))

    const NAME = ${JSON.stringify('探针RUN命令')}
    const ALIVE = ${JSON.stringify(join(HERE, 'fixture', 'alive.mjs'))}
    void (await window.api.tree.createCommand({
      parentId: ${JSON.stringify(groupA.id)},
      name: NAME,
      command: 'node ' + ALIVE,
    }))
    await new Promise((r) => setTimeout(r, 500))

    const styleOf = (t) => {
      const c = [...document.querySelectorAll('.card')]
        .find((x) => (x.textContent || '').includes(t))
      if (!c) return null
      const s = getComputedStyle(c)
      return {
        bg: s.backgroundColor,
        bar: s.boxShadow,
        cls: c.className,
        pill: (c.querySelector('.pill')?.textContent || '').trim(),
      }
    }

    const idle = styleOf(NAME)
    const other = styleOf('build:prod')

    const list = await window.api.tree.list()
    const temp = list.find((n) => n.name === NAME)
    if (!temp) return { error: '没建出探针RUN命令' }
    await window.api.processes.start(temp.id)
    // 必须等过 READY_TIMEOUT_MS（10 秒）。alive.mjs 什么都不打印，就绪信号永远
    // 不会命中，状态要等超时降级才从 starting 变成 running —— 只等 2.5 秒的话
    // 测到的是 amber 的 busy 底色，绿的那条根本没被执行。
    await new Promise((r) => setTimeout(r, 11500))
    const running = styleOf(NAME)
    return { idle, running, other, nodeId: temp.id }
  })()`)

  check(
    '运行中的卡片整张换底色（不只是状态点变绿）',
    runProbe.running != null &&
      runProbe.idle != null &&
      runProbe.running.pill === '运行中' &&
      runProbe.running.cls.includes('running') &&
      runProbe.running.bg !== runProbe.idle.bg &&
      runProbe.running.bg !== runProbe.other?.bg &&
      runProbe.running.bar !== runProbe.idle.bar,
    JSON.stringify({
      空闲: runProbe.idle?.bg,
      运行中: runProbe.running?.bg,
      同屏别的卡片: runProbe.other?.bg,
      状态胶囊: runProbe.running?.pill,
      类名: runProbe.running?.cls,
    }),
  )

  // 截图：整张底色「够不够明显」是审美判断，只有真机图能说明问题
  if (SHOT_DIR && runProbe.nodeId) {
    await cdp.send('Page.enable')
    await sleep(200)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-card-running.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-card-running.png')
  }

  if (runProbe.nodeId) {
    await cdp.evaluate(`(async () => {
      await window.api.processes.stop(${JSON.stringify(runProbe.nodeId)})
      await new Promise((r) => setTimeout(r, 1200))
      await window.api.tree.remove(${JSON.stringify(runProbe.nodeId)})
    })()`)
  }

  // --- 13. 「编辑命令可见性」弹窗（卡片区标题行入口） ---------------------
  //
  // 这一节替代了旧的「卡片头上有个隐藏按钮」断言 —— 那个按钮已按用户要求拿掉，
  // 隐藏改成「点按钮 → 弹窗 → 勾选」。勾上 = 显示，取消勾选 = 隐藏，立即生效。
  //
  // seed 里 showHiddenCommands = true，所以隐藏不会让卡片消失，而是给它打上
  // 「已隐藏」标记 —— 断言查的就是这个标记，而不是「卡片不见了」。
  //
  // 自建一个只属于探针的分组 + 两条命令：这样「全部隐藏 / 全部显示」不会动到
  // seed 里本来就隐藏着的那些命令（收尾会把整个分组删掉，连带子节点）。
  const visProbe = await cdp.evaluate(`(async () => {
    const NAME = ${JSON.stringify('探针VIS分组')}
    const rows = () => [...document.querySelectorAll('.tree-pane .row')]
    const readList = () => {
      const rs = [...document.querySelectorAll('.vis-list .vis-row')]
      return {
        rows: rs.length,
        checked: rs.filter((r) => r.querySelector('input')?.checked).length,
        names: rs.map((r) => (r.querySelector('.vis-name')?.textContent || '').trim()),
      }
    }
    const gridCount = () => (document.querySelector('.grid-head .count')?.textContent || '').trim()
    const marked = (n) => [...document.querySelectorAll('.card')]
      .filter((c) => (c.textContent || '').includes(n))
      .map((c) => (c.textContent || '').includes('已隐藏'))

    const group = await window.api.tree.createGroup({
      parentId: ${JSON.stringify(groupA.id)},
      name: NAME,
    })
    await new Promise((r) => setTimeout(r, 300))
    await window.api.tree.createCommand({ parentId: group.id, name: 'vis-a', command: 'echo a' })
    await window.api.tree.createCommand({ parentId: group.id, name: 'vis-b', command: 'echo b' })
    await new Promise((r) => setTimeout(r, 500))

    // 先把卡片区切到这个分组，统计必须与它的命令数一致
    rows().find((r) => (r.textContent || '').includes(NAME))?.click()
    await new Promise((r) => setTimeout(r, 400))
    const countBefore = gridCount()

    const btn = [...document.querySelectorAll('.grid-head button')]
      .find((b) => (b.textContent || '').trim() === '命令可见性')
    if (!btn) return { error: '卡片区标题行没有「命令可见性」按钮', groupId: group.id }
    btn.click()
    await new Promise((r) => setTimeout(r, 400))

    const title = (document.querySelector('.modal-head')?.textContent || '').trim()
    const opened = readList()

    return { groupId: group.id, countBefore, title, opened }
  })()`)

  // 截图必须趁弹窗还开着 —— 关掉之后只剩卡片区，看不出这个功能长什么样。
  // 所以这一段拆成两次 evaluate，中间留给 Node 侧抓图。
  if (SHOT_DIR) {
    await cdp.send('Page.enable')
    await sleep(200)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-visibility.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-visibility.png')
  }

  const visToggleProbe = await cdp.evaluate(`(async () => {
    const readList = () => {
      const rs = [...document.querySelectorAll('.vis-list .vis-row')]
      return {
        rows: rs.length,
        checked: rs.filter((r) => r.querySelector('input')?.checked).length,
        names: rs.map((r) => (r.querySelector('.vis-name')?.textContent || '').trim()),
      }
    }
    const gridCount = () => (document.querySelector('.grid-head .count')?.textContent || '').trim()
    const marked = (n) => [...document.querySelectorAll('.card')]
      .filter((c) => (c.textContent || '').includes(n))
      .map((c) => (c.textContent || '').includes('已隐藏'))
    const allBtn = (t) => [...document.querySelectorAll('.modal button')]
      .find((b) => (b.textContent || '').trim() === t)
    const rowOf = (n) => [...document.querySelectorAll('.vis-list .vis-row')]
      .find((r) => (r.querySelector('.vis-name')?.textContent || '').trim() === n)

    // ① 用户真正的动作：手动取消一条的勾选，只有它该被标成已隐藏
    const box = rowOf('vis-a')?.querySelector('input')
    if (box) {
      box.checked = false
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise((r) => setTimeout(r, 800))
    const singleOff = readList()
    const singleOffMarks = { a: marked('vis-a'), b: marked('vis-b') }

    // ② 全部隐藏 / 全部显示
    allBtn('全部隐藏')?.click()
    await new Promise((r) => setTimeout(r, 800))
    const afterHide = readList()
    const afterHideCount = gridCount()
    const afterHideMarks = marked('vis-a')

    allBtn('全部显示')?.click()
    await new Promise((r) => setTimeout(r, 800))
    const afterShow = readList()

    allBtn('完成')?.click()
    await new Promise((r) => setTimeout(r, 300))
    const closed = document.querySelectorAll('.modal').length === 0

    return { singleOff, singleOffMarks, afterHide, afterHideCount, afterHideMarks, afterShow, closed }
  })()`)

  // --- 14. 「编辑命令可见性」的第二个入口（树右键）与空范围置灰 -----------
  //
  // 用户要的是「针对这个项目」的可见性编辑，所以同一个弹窗必须也能从项目/分组的
  // 右键菜单打开，并且标题带上这一层的名字 —— 否则用户看不出这次改的是哪一层。
  // 空分组则要置灰：灰项看得见，点开一个空弹窗像出了错。
  const visMenuProbe = await cdp.evaluate(`(async () => {
    const NAME = ${JSON.stringify('探针VIS分组')}
    const EMPTY = ${JSON.stringify('探针空分组')}
    const rows = () => [...document.querySelectorAll('.tree-pane .row')]
    const findItem = () => [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => (b.textContent || '').trim() === '编辑命令可见性…') ?? null
    const openMenuOn = async (name) => {
      const row = rows().find((r) => (r.textContent || '').includes(name))
      if (!row) return { missing: true }
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 300 }),
      )
      await new Promise((r) => setTimeout(r, 300))
      const item = findItem()
      return { disabled: item ? item.disabled === true : null }
    }
    const closeModal = async () => {
      ;[...document.querySelectorAll('.modal button')]
        .find((b) => (b.textContent || '').trim() === '完成')?.click()
      await new Promise((r) => setTimeout(r, 300))
    }

    // ① 有命令的分组：菜单项可用，点开弹窗的标题带分组名
    const ok = await openMenuOn(NAME)
    findItem()?.click()
    await new Promise((r) => setTimeout(r, 400))
    const title = (document.querySelector('.modal-head')?.textContent || '').trim()
    await closeModal()
    const closed = document.querySelectorAll('.modal').length === 0

    // ② 空分组：菜单项必须是灰的，点一下也打不开空弹窗
    const empty = await window.api.tree.createGroup({
      parentId: ${JSON.stringify(groupA.id)},
      name: EMPTY,
    })
    await new Promise((r) => setTimeout(r, 500))
    const grey = await openMenuOn(EMPTY)
    findItem()?.click()
    await new Promise((r) => setTimeout(r, 300))
    const openedOnEmpty = document.querySelectorAll('.modal').length > 0

    // 收拾干净：整个探针分组连带子命令一起删（remove 会连子树一起收）
    const list = await window.api.tree.list()
    for (const n of list) {
      if (n.name === NAME || n.name === EMPTY) await window.api.tree.remove(n.id)
    }
    await new Promise((r) => setTimeout(r, 400))
    const leftover = (await window.api.tree.list())
      .filter((n) => n.name === NAME || n.name === EMPTY).length

    return {
      okDisabled: ok.disabled,
      title,
      closed,
      greyDisabled: grey.disabled,
      openedOnEmpty,
      leftover,
      emptyId: empty.id,
    }
  })()`)

  check(
    '卡片区标题行有「命令可见性」入口，弹窗标题与统计都对得上当前范围',
    visProbe.countBefore === '2 条命令' &&
      typeof visProbe.title === 'string' &&
      visProbe.title === '编辑命令可见性 · 探针VIS分组' &&
      visProbe.opened?.rows === 2,
    JSON.stringify({
      统计: visProbe.countBefore,
      标题: visProbe.title,
      列表: visProbe.opened,
      error: visProbe.error,
    }),
  )
  check(
    '取消勾选只隐藏那一条，别的命令不受影响',
    visToggleProbe.singleOff?.checked === 1 &&
      (visToggleProbe.singleOffMarks?.a || []).includes(true) &&
      !(visToggleProbe.singleOffMarks?.b || []).includes(true),
    JSON.stringify({
      勾选状态: visToggleProbe.singleOff,
      卡片标记: visToggleProbe.singleOffMarks,
    }),
  )
  check(
    '「全部隐藏」把整个范围都隐藏，标题行的统计跟着变',
    visToggleProbe.afterHide?.checked === 0 &&
      visToggleProbe.afterHideCount === '2 条命令 · 2 隐藏' &&
      (visToggleProbe.afterHideMarks || []).includes(true),
    JSON.stringify({
      隐藏后: visToggleProbe.afterHide,
      隐藏后统计: visToggleProbe.afterHideCount,
      卡片标记: visToggleProbe.afterHideMarks,
    }),
  )
  check(
    '「全部显示」把勾选恢复回来',
    visToggleProbe.afterShow?.checked === 2 && (visToggleProbe.afterShow?.rows || 0) === 2,
    JSON.stringify(visToggleProbe.afterShow),
  )
  check('「完成」关掉弹窗', visToggleProbe.closed === true, `closed=${visToggleProbe.closed}`)
  check(
    '右键菜单里也能打开同一个弹窗，标题带分组名',
    visMenuProbe.okDisabled === false &&
      visMenuProbe.title === '编辑命令可见性 · 探针VIS分组' &&
      visMenuProbe.closed === true,
    JSON.stringify(visMenuProbe),
  )
  check(
    '空分组时菜单项置灰，点不开空弹窗',
    visMenuProbe.greyDisabled === true && visMenuProbe.openedOnEmpty === false,
    JSON.stringify({
      置灰: visMenuProbe.greyDisabled,
      点开了: visMenuProbe.openedOnEmpty,
    }),
  )
  check(
    '探针建的临时分组已收拾干净',
    visMenuProbe.leftover === 0,
    `leftover=${visMenuProbe.leftover}`,
  )

  // --- 15. 命令标记（marked）：卡片星标 + 「启动已标记」只拉起被标记的 ---------
  //
  // 用户要的是「在卡片上打标记，点『启动已标记』时只拉起被标记的那批，没标记的
  // 不启动」。这里测三件事：
  //   ① 星标点一下能把标记翻过来（卡片上看得见，store 里也真的改了）
  //   ② 一条都没标记时点「启动已标记」给的是提示，而不是静默成功
  //   ③ 标记之后「启动已标记」只拉起被标记的那条，没标记的仍是「未启动」
  //
  // 用 fixture/alive.mjs 当常驻进程：它什么都不打印，起来之后稳定停在
  // starting/running，所以「起来了」与「没起来」在卡片上的差别是稳定的 ——
  // 换成 echo 之类秒退的命令，两条最终都停在 exited，根本测不出区别。
  const MARK = '探针MARK命令'
  const NOMARK = '探针NOMARK命令'

  const markProbe = await cdp.evaluate(`(async () => {
    const MARK = ${JSON.stringify(MARK)}
    const NOMARK = ${JSON.stringify(NOMARK)}
    const ALIVE = ${JSON.stringify(join(HERE, 'fixture', 'alive.mjs'))}
    const GROUP = ${JSON.stringify(groupA.id)}
    const GROUP_NAME = ${JSON.stringify(groupA.name)}

    const rowOf = (t) => [...document.querySelectorAll('.tree-pane .row')]
      .find((r) => (r.textContent || '').includes(t))
    const cardOf = (t) => [...document.querySelectorAll('.card')]
      .find((c) => (c.querySelector('.name')?.textContent || '').trim() === t) ?? null
    const starOf = (t) => cardOf(t)?.querySelector('.star') ?? null
    const starText = (t) => (starOf(t)?.textContent || '').trim()
    const pillOf = (t) => (cardOf(t)?.querySelector('.pill')?.textContent || '').trim()
    const noticeText = () =>
      (document.querySelector('.banner.notice .banner-text')?.textContent || '').trim()
    const closeNotice = () => {
      ;[...document.querySelectorAll('.banner.notice button')].forEach((b) => b.click())
    }
    const gridCount = () => (document.querySelector('.grid-head .count')?.textContent || '').trim()
    const startAllBtn = () => [...document.querySelectorAll('.titlebar button')]
      .find((b) => (b.textContent || '').trim() === '启动已标记')

    // 把卡片区切到 groupA，并清掉可能残留的提示条 —— 否则第 ② 步会把上一节
    // 留下的旧提示当成自己的结果，那是最典型的「断言空过」。
    rowOf(GROUP_NAME)?.click()
    await new Promise((r) => setTimeout(r, 400))
    closeNotice()
    await new Promise((r) => setTimeout(r, 200))

    await window.api.tree.createCommand({ parentId: GROUP, name: MARK, command: 'node ' + ALIVE })
    await window.api.tree.createCommand({ parentId: GROUP, name: NOMARK, command: 'node ' + ALIVE })
    await new Promise((r) => setTimeout(r, 600))

    const before = { mark: starText(MARK), nomark: starText(NOMARK) }

    // ② 一条都没标记：点「启动已标记」应当只给提示，什么都不启动
    startAllBtn()?.click()
    await new Promise((r) => setTimeout(r, 600))
    const emptyNotice = noticeText()
    const stillIdle = pillOf(MARK)
    closeNotice()
    await new Promise((r) => setTimeout(r, 200))

    // ① 点星标翻标记 —— 这就是用户真正的动作
    starOf(MARK)?.click()
    await new Promise((r) => setTimeout(r, 500))
    const afterStar = {
      mark: starText(MARK),
      markCls: starOf(MARK)?.className || '',
      nomark: starText(NOMARK),
      count: gridCount(),
    }
    const list = await window.api.tree.list()
    const markNode = list.find((n) => n.name === MARK)
    const nomarkNode = list.find((n) => n.name === NOMARK)

    // ③ 启动已标记：只该拉起被标记的那条
    startAllBtn()?.click()
    await new Promise((r) => setTimeout(r, 2500))
    const pills = { mark: pillOf(MARK), nomark: pillOf(NOMARK) }
    const noticeAfter = noticeText()

    return {
      before,
      emptyNotice,
      stillIdle,
      afterStar,
      markedInStore: markNode?.marked === true,
      nomarkInStore: nomarkNode?.marked === true,
      pills,
      noticeAfter,
      markId: markNode?.id ?? null,
      nomarkId: nomarkNode?.id ?? null,
    }
  })()`)

  // 截图：★ 与 ☆ 的差别是视觉判断，只有真机图能说明问题
  if (SHOT_DIR) {
    // 先把卡片区滚到底 —— 探针建的两条命令排在最后，不滚下去的话图上根本看不见
    // ★/☆ 的对比，这张图就白拍了。
    await cdp.evaluate(`(() => {
      const body = document.querySelector('.grid-body')
      if (body) body.scrollTop = body.scrollHeight
    })()`)
    await sleep(300)
    await cdp.send('Page.enable')
    await sleep(200)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-marked.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-marked.png')
  }

  check(
    '卡片头有常驻星标，未标记时是空心 ☆',
    markProbe.before?.mark === '☆' && markProbe.before?.nomark === '☆',
    JSON.stringify(markProbe.before),
  )
  check(
    '一条都没标记时点「启动已标记」给提示，不静默成功也不启动任何进程',
    typeof markProbe.emptyNotice === 'string' &&
      markProbe.emptyNotice.includes('还没有标记任何命令') &&
      markProbe.stillIdle === '未启动',
    JSON.stringify({ 提示: markProbe.emptyNotice, 未标记的卡片: markProbe.stillIdle }),
  )
  check(
    '点一下星标就把标记翻过来（实心 ★，store 里的 marked 同步）',
    markProbe.afterStar?.mark === '★' &&
      (markProbe.afterStar?.markCls || '').includes('on') &&
      markProbe.afterStar?.nomark === '☆' &&
      markProbe.markedInStore === true &&
      markProbe.nomarkInStore === false,
    JSON.stringify({
      星标: markProbe.afterStar,
      store里的: { mark: markProbe.markedInStore, nomark: markProbe.nomarkInStore },
    }),
  )
  check(
    '标题行的统计把「已标记」算进去',
    (markProbe.afterStar?.count || '').includes('已标记'),
    `统计=${markProbe.afterStar?.count}`,
  )
  check(
    '「启动已标记」只拉起被标记的那条，没标记的不启动',
    ['启动中', '运行中'].includes(markProbe.pills?.mark) &&
      markProbe.pills?.nomark === '未启动' &&
      markProbe.noticeAfter === '',
    JSON.stringify({ 卡片状态: markProbe.pills, 提示条: markProbe.noticeAfter }),
  )

  // 收尾：停掉起来的那个，再把两条临时命令删掉
  const markIds = [markProbe.markId, markProbe.nomarkId].filter(Boolean)
  if (markIds.length) {
    await cdp.evaluate(`(async () => {
      const ids = ${JSON.stringify(markIds)}
      for (const id of ids) await window.api.processes.stop(id)
      await new Promise((r) => setTimeout(r, 1500))
      for (const id of ids) await window.api.tree.remove(id)
    })()`)
    const markLeftover = await cdp.evaluate(`(async () => {
      const list = await window.api.tree.list()
      const names = ${JSON.stringify([MARK, NOMARK])}
      return list.filter((n) => names.includes(n.name)).length
    })()`)
    check('探针建的标记命令已收拾干净', markLeftover === 0, `leftover=${markLeftover}`)
  }

  // -------------------------------------------------------------------------
  // 设置弹窗里的「命令可见性」按项目分段
  // -------------------------------------------------------------------------
  //
  // 用户的诉求（原话）：「命令可见性 只是针对一个项目的，不是针对所有的 每个项目一个」。
  // 所以这里查两件事：段的标题就是**顶层项目**的名字，以及**每条命令只落在它自己那段里**
  // —— 后者才是「不再被拍平成一个跨项目长列表」的真正证据。
  //
  // 期望值不从界面上抄，而是从 store 自己算一遍「每条命令属于哪个顶层分组」再对账。
  //
  // seed 里其实只有一个顶层项目（spike-fixture-web 也是它的子分组），只验出一段并不能
  // 说明「每项目一段」—— 把全部命令都塞进第一段也照样通过。所以这里现建一个**第二个顶层
  // 项目**，里面放一条根级命令和一条子分组命令，段落归属与相对路径才都有真凭据。
  const visSecond = await cdp.evaluate(`(async () => {
    const top = await window.api.tree.createGroup({ parentId: null, name: ${JSON.stringify('探针第二项目')} })
    const sub = await window.api.tree.createGroup({ parentId: top.id, name: ${JSON.stringify('子包')} })
    await window.api.tree.createCommand({ parentId: top.id, name: ${JSON.stringify('seg-root')}, command: 'echo root' })
    await window.api.tree.createCommand({ parentId: sub.id, name: ${JSON.stringify('seg-sub')}, command: 'echo sub' })
    await new Promise((r) => setTimeout(r, 700))
    return { projectId: top.id }
  })()`)

  const visSettings = await cdp.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => (b.textContent || '').trim() === '设置')
    if (!btn) return { error: '顶栏没有「设置」按钮' }
    btn.click()
    await new Promise((r) => setTimeout(r, 400))

    const field = [...document.querySelectorAll('.modal .field')]
      .find((f) => (f.querySelector('label')?.textContent || '').trim() === '命令可见性')
    if (!field) return { error: '设置弹窗里没有「命令可见性」这一块' }
    // 这一块在弹窗里偏下，不滚过去截图里就只有主题那几行
    field.scrollIntoView({ block: 'start' })
    await new Promise((r) => setTimeout(r, 300))

    const sections = [...field.querySelectorAll('.vis-section')].map((s) => ({
      name: (s.querySelector('.vis-project')?.textContent || '').trim(),
      stat: (s.querySelector('.vis-stat')?.textContent || '').trim(),
      rows: [...s.querySelectorAll('.vis-row')]
        .map((r) => (r.querySelector('.vis-name')?.textContent || '').trim()),
      groups: [...s.querySelectorAll('.vis-group')].map((g) => (g.textContent || '').trim()),
      lists: s.querySelectorAll('.vis-list').length,
    }))

    const flat = await window.api.tree.list()
    const byId = new Map(flat.map((n) => [n.id, n]))
    const rootNameOf = (node) => {
      let cur = node
      let last = null
      const seen = new Set()
      while (cur && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
        seen.add(cur.parentId)
        cur = byId.get(cur.parentId)
        last = cur
      }
      return last && last.kind === 'group' ? last.name : '（未分组）'
    }
    const expect = new Map()
    for (const n of flat) {
      if (n.kind !== 'command') continue
      const key = rootNameOf(n)
      if (!expect.has(key)) expect.set(key, [])
      expect.get(key).push(n.name)
    }

    return {
      sections,
      expect: [...expect.entries()].map(([name, rows]) => ({ name, rows })),
      totalCommands: flat.filter((n) => n.kind === 'command').length,
    }
  })()`)

  // 截图要趁弹窗还开着，所以跟 VisibilityModal 那一段一样拆成两次 evaluate。
  if (SHOT_DIR) {
    await cdp.send('Page.enable')
    await sleep(200)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, 'ui-vis-settings.png'), Buffer.from(png.data, 'base64'))
    console.log('[probe] 截图 ui-vis-settings.png')
  }

  await cdp.evaluate(`(() => { document.querySelector('.overlay')?.click() })()`)

  const norm = (list) => [...list].map((s) => String(s).trim()).sort().join('\\u0001')
  const visSections = visSettings.sections || []
  const visExpect = visSettings.expect || []

  check(
    '设置里的「命令可见性」按项目分段，段的标题就是顶层项目的名字',
    !visSettings.error &&
      visSections.length === visExpect.length &&
      visSections.length > 1 &&
      visSections.every((s) => visExpect.some((e) => e.name === s.name)) &&
      visSections.every((s) => s.lists === 1) &&
      visSections.reduce((sum, s) => sum + s.rows.length, 0) === visSettings.totalCommands,
    visSettings.error ?? JSON.stringify({
      段: visSections.map((s) => `${s.name}（${s.rows.length} 条）`),
      期望的段: visExpect.map((e) => `${e.name}（${e.rows.length} 条）`),
      命令总数: visSettings.totalCommands,
    }),
  )

  check(
    '每个项目的命令只落在它自己那一段里（不再是一个跨项目的长列表）',
    !visSettings.error &&
      visSections.length > 0 &&
      visSections.every((s) => {
        const e = visExpect.find((x) => x.name === s.name)
        return !!e && norm(e.rows) === norm(s.rows)
      }),
    JSON.stringify(visSections.map((s) => ({ 段: s.name, 行: s.rows }))),
  )

  const segSection = visSections.find((s) => s.name === '探针第二项目')
  check(
    '段内行尾只画这个项目之内的子分组路径（seg-sub 显示「子包」，不是「探针第二项目 / 子包」）',
    !visSettings.error &&
      !!segSection &&
      norm(segSection.rows) === norm(['seg-root', 'seg-sub']) &&
      norm(segSection.groups) === norm(['', '子包']),
    JSON.stringify(segSection ?? { 未找到: '探针第二项目' }),
  )

  // 收尾：把刚建的第二个项目整棵删掉（连带子分组与两条命令）
  if (visSecond?.projectId) {
    await cdp.evaluate(`(async () => { await window.api.tree.remove(${JSON.stringify(visSecond.projectId)}) })()`)
    await sleep(400)
    const visLeft = await cdp.evaluate(`(async () => {
      const list = await window.api.tree.list()
      const names = ${JSON.stringify(['探针第二项目', '子包', 'seg-root', 'seg-sub'])}
      return list.filter((n) => names.includes(n.name)).length
    })()`)
    check('探针建的第二项目已收拾干净', visLeft === 0, `leftover=${visLeft}`)
  }

  // --- 16. 日志面板：命令失败时才自动摊开 ----------------------------------
  //
  // 这是「默认收起」能成立的那一环 —— 少了它，收起就等于把报错一起藏了。
  //
  // 两条豁免刻意分开测。只验「失败会展开」是不够的：把退出码 0 也一并展开同样能
  // 过那条断言，而那样一来每次正常跑完（一次构建、一次 lint）都会把面板掀开打断人。
  const failLog = await cdp.evaluate(`(async () => {
    const nodes = await window.api.tree.list()
    const group = nodes.find((n) => n.kind === 'group' && n.path)
    if (!group) return { error: '没有绑定目录的分组' }

    const findBtn = () => [...document.querySelectorAll('.log-pane .log-head .btn')]
      .find((b) => ['收起', '展开'].includes((b.textContent || '').trim()))
    const snap = () => {
      const b = findBtn()
      return {
        collapsed: b ? (b.textContent || '').trim() === '展开' : null,
        hasBody: !!document.querySelector('.log-pane .log-body'),
        title: (document.querySelector('.log-pane .title')?.textContent || '').trim(),
      }
    }
    const collapse = async () => {
      const b = findBtn()
      if (b && (b.textContent || '').trim() === '收起') {
        b.click()
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    // 前面几节真跑过命令，面板可能已经被掀开了 —— 先收回原位再测
    await collapse()
    const before = snap()

    // 失败的那条用「cmd /c exit 3」而不是 node：不依赖 PATH 上有没有 node，
    // 也没有引号和括号要跟 cmd 的解析规则纠缠。
    // （注意这段代码整个处在模板字符串里，注释里不能再出现反引号。）
    const bad = await window.api.tree.createCommand({
      parentId: group.id,
      name: '探针失败命令',
      command: 'cmd /c exit 3',
    })
    await window.api.processes.start(bad.id)
    await new Promise((r) => setTimeout(r, 3000))
    const afterFail = snap()
    const crash = document.querySelector('.banner.crash')
    const crashText = crash ? crash.textContent || '' : null

    // 正常跑完的那条：退出码 0，**不该**掀开
    await collapse()
    const collapsedAgain = snap()
    const ok = await window.api.tree.createCommand({
      parentId: group.id,
      name: '探针正常退出命令',
      command: 'echo 探针正常退出',
    })
    await window.api.processes.start(ok.id)
    await new Promise((r) => setTimeout(r, 3000))
    const afterOk = snap()

    await window.api.tree.remove(ok.id)
    await window.api.tree.remove(bad.id)

    return {
      before,
      collapsedAgain,
      afterFail,
      afterOk,
      failId: bad.id,
      // 横幅上写的是命令的**名字**（只有拿不到名字时才退化成 id），所以按名字对
      crashHasName: !!crashText && crashText.includes('探针失败命令'),
      crashText,
    }
  })()`)

  check(
    '命令失败（退出码 3）时日志面板自动摊开，并聚焦到那条命令',
    !failLog.error &&
      failLog.before?.collapsed === true &&
      failLog.before?.hasBody === false &&
      failLog.afterFail?.hasBody === true &&
      failLog.afterFail?.title === '探针失败命令',
    failLog.error ?? JSON.stringify({ 收起时: failLog.before, 失败后: failLog.afterFail }),
  )

  check(
    '同一次失败也报了「意外退出」横幅，且点名的正是这条命令（横幅与日志同一件事）',
    !failLog.error && failLog.crashHasName === true,
    JSON.stringify({ 横幅: failLog.crashText, 期望含: '探针失败命令' }),
  )

  check(
    '正常退出（退出码 0）不会掀开收着的日志',
    !failLog.error && failLog.collapsedAgain?.collapsed === true && failLog.afterOk?.hasBody === false,
    failLog.error ?? JSON.stringify({ 再次收起: failLog.collapsedAgain, 正常退出后: failLog.afterOk }),
  )

  cdp.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n[probe] ${results.length - failed.length}/${results.length} 通过`)
  exitCode = failed.length ? 1 : 0
} catch (err) {
  console.error('[probe] 失败：', err instanceof Error ? err.message : err)
  exitCode = 1
} finally {
  killTree(app.pid)
  killStrayElectron()
}

process.exit(exitCode)
