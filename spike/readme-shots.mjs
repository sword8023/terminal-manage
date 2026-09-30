/**
 * 生成 README 用的干净截图。
 *
 * 为什么不直接拿界面探针（ui-probe.mjs）的截图：那批图是**跑测试过程中的副产物**，
 * 拍的时候分组已经被重命名成「探针改名OK」、卡片里插着「探针RUN命令」，还挂着探针
 * 自己制造的崩溃横幅。拿来当文档配图不合格。
 *
 * 这个脚本只干一件事：用仓库自带的夹具起一个隔离实例，点几下按钮，
 * 把几个「看起来就是日常在用」的状态拍下来。
 *
 * 用法：`node spike/readme-shots.mjs`
 *   产物（默认写 docs/，用 TM_SHOT_DIR 改输出目录）：
 *     docs/screenshot-running.png   一条命令跑起来：卡片转「运行中」+ 底部实时日志
 *     docs/screenshot-settings.png  设置面板：命令可见性按项目分段
 *   README 的头图是 docs/screenshot-demo.png，出自 spike/shot.ps1（那个连窗口边框一起抓）。
 *
 * 隔离与安全：
 *   - 全程跑在 spike/.readme-profile/ 里（TM_USER_DATA），**不碰你真实的 config.json**
 *   - 结束时只杀自己起的进程树（按 PID），外加清理「命令行指向本仓库」的 electron 残留；
 *     **绝不**按映像名 taskkill electron.exe —— 那会连别人正在跑的实例一起干掉
 *   - 应用在 TM_DEBUG=1 时打开 CDP 端口 9223，截图走 Page.captureScreenshot（只含客户端区域）
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PROFILE = join(HERE, '.readme-profile')
const CONFIG = join(PROFILE, 'config.json')
const OUT_DIR = process.env.TM_SHOT_DIR ? resolve(process.env.TM_SHOT_DIR) : join(ROOT, 'docs')
const CDP_PORT = Number(process.env.TM_CDP_PORT ?? 9223)
const RENDERER_HINT = '5273'
const PROJECTS = [join(HERE, 'fixture'), join(HERE, 'fixture-web')]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[shots] ${m}`)

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（与 ui-probe.mjs 同一套路，零依赖：Node 自带 WebSocket）
// ---------------------------------------------------------------------------

class Cdp {
  constructor(url) {
    this.url = url
    this.seq = 0
    this.pending = new Map()
  }

  connect() {
    return new Promise((done, fail) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => fail(new Error('CDP WebSocket 连接超时')), 15000)
      ws.onopen = () => {
        clearTimeout(timer)
        done()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        fail(new Error('CDP WebSocket 出错'))
      }
      ws.onmessage = (event) => {
        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: no } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) no(new Error(msg.error.message))
          else ok(msg.result)
        }
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((ok, no) => this.pending.set(id, { resolve: ok, reject: no }))
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

async function waitForTarget(timeoutMs = 150000) {
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

async function waitForRows(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await cdp.evaluate(`document.querySelectorAll('.tree-pane .row.group').length`)
    if (n > 0) return n
    await sleep(300)
  }
  throw new Error('等不到分组树渲染出行（界面没挂载，或数据为空）')
}

// ---------------------------------------------------------------------------
// 启停
// ---------------------------------------------------------------------------

/** 只清理命令行里指向本仓库的 electron 残留，理由见文件头 */
function killStrayElectron() {
  const rootLower = ROOT.toLowerCase().split("'").join("''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'"`,
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${rootLower}') }`,
    `ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F }`,
  ].join(' | ')
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

function launchApp() {
  // stdout 必须是文件而不是管道：走管道时应用会自己退出（见 docs/技术方案.md 附录 B）
  const logFd = openSync(join(HERE, 'shots-dev.log'), 'a')
  return spawn('npm run dev', {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, TM_DEBUG: '1', TM_USER_DATA: PROFILE },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
}

// ---------------------------------------------------------------------------
// 截图
// ---------------------------------------------------------------------------

async function shot(cdp, name) {
  const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(png.data, 'base64'))
  log(`截图 ${name}.png（${Buffer.from(png.data, 'base64').length} 字节）`)
  return file
}

/** 点卡片上的某个按钮。返回实际点到了什么，方便定位选择器失效 */
async function clickCardButton(cdp, cardName, buttonText) {
  return cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')]
      .find((c) => (c.querySelector('.name')?.textContent || '').trim() === ${JSON.stringify(cardName)})
    if (!card) return '找不到卡片 ' + ${JSON.stringify(cardName)}
    // 按钮文字带图标前缀（运行中是「▶ 启动」、跑起来之后变「■ 停止」），所以用 includes 而不是全等
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(buttonText)}))
    if (!btn) return '卡片上按钮是：' + [...card.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')
    btn.click()
    return 'clicked'
  })()`)
}

async function openSettings(cdp) {
  return cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.titlebar button')]
      .find((b) => b.textContent.trim() === '设置')
    if (!btn) return '标题栏按钮是：' + [...document.querySelectorAll('.titlebar button')].map((b) => b.textContent.trim()).join(' | ')
    btn.click()
    return 'clicked'
  })()`)
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  // 1) 一次性 profile：每次都从干净的夹具配置开始
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  const seed = spawnSync('node', ['spike/seed.ts', CONFIG, ...PROJECTS], { cwd: ROOT, encoding: 'utf-8' })
  if (seed.status !== 0) throw new Error(`seed 失败：${seed.stderr || seed.stdout}`)
  log(`已 seed 一次性 profile：${CONFIG}`)

  // 截图要的是「日常在用」的样子：暗色主题、日志面板已经摊开、彩色输出打开
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf-8'))
  cfg.settings = { ...(cfg.settings ?? {}), theme: 'dark', logCollapsed: false, forceColor: true }
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))

  killStrayElectron()
  const child = launchApp()
  let cdp = null

  try {
    const target = await waitForTarget()
    log(`target: ${target.url}`)
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await waitForRows(cdp)
    await sleep(1500) // 等首屏过渡与字体稳定

    // 启动 spike-fixture 的 dev，等它真的跑起来并且日志进来了
    const clicked = await clickCardButton(cdp, 'dev', '启动')
    log(`点「启动」：${clicked}`)
    if (clicked !== 'clicked') throw new Error('没能启动命令，选择器可能变了')

    const deadline = Date.now() + 30000
    let st = null
    while (Date.now() < deadline) {
      st = await cdp.evaluate(`(() => {
        const card = [...document.querySelectorAll('.card')]
          .find((c) => (c.querySelector('.name')?.textContent || '').trim() === 'dev')
        return {
          running: !!card && card.classList.contains('running'),
          lines: document.querySelectorAll('.log-pane .viewport .line').length,
        }
      })()`)
      if (st.running && st.lines >= 4) break
      await sleep(400)
    }
    log(`运行状态：running=${st?.running} 日志行数=${st?.lines}`)
    await sleep(800) // 让进度条的几帧都落到日志里
    await shot(cdp, 'screenshot-running')

    // 设置弹窗（命令可见性按项目分段那一屏）
    const opened = await openSettings(cdp)
    log(`打开设置：${opened}`)
    if (opened === 'clicked') {
      await sleep(900)
      await shot(cdp, 'screenshot-settings')
      await cdp.evaluate(`(() => { document.querySelector('.modal .close, .modal-head .x')?.click() })()`)
      await sleep(300)
    }

    // 收尾：停掉命令，免得留下正在跑的子进程
    await clickCardButton(cdp, 'dev', '停止')
    await sleep(600)
  } finally {
    cdp?.close()
    killTree(child.pid)
    await sleep(1200)
    killStrayElectron()
    rmSync(join(HERE, 'fixture', '.grandchild.pid'), { force: true })
    log('已清理自己起的进程')
  }
}

main().catch((err) => {
  console.error('[shots] 失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
