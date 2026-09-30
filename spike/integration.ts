/**
 * ProcessManager 端到端集成测试（刻意不经过 Electron）。
 *
 * ProcessManager 本身不 import electron —— 就是为了让核心逻辑能在普通 Node 下
 * 用**真实子进程**跑完整生命周期：启动 → 就绪识别 → 端口解析 → 日志归一化 →
 * 杀整棵进程树 → 世代号防护 → 幂等保护。
 *
 * 由 esbuild 打成单文件再交给 node 执行（见 package.json 的 test:integration）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { ProcessManager } from '../src/main/core/ProcessManager'
import type { AppSettings, ExitInfo, LineEvent, RuntimeState, SpawnSpec } from '../src/shared/types'

const FIXTURE = join(process.cwd(), 'spike', 'fixture')
const PID_FILE = join(FIXTURE, '.grandchild.pid')
const PORT = 5173
const ID = 'itest'

const results: Array<{ name: string; ok: boolean; detail: string }> = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(60)
  }
  return false
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const settle = (v: boolean): void => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(700)
    sock.on('connect', () => settle(true))
    sock.on('error', () => settle(false))
    sock.on('timeout', () => settle(false))
  })
}

/** 就绪状态与端口可连之间允许有一个极短的窗口（真实 Vite 里几乎为 0） */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await portOpen(port)) return true
    if (Date.now() >= deadline) return false
    await sleep(80)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(FIXTURE, 'package.json'))) {
    console.error(`找不到夹具：${FIXTURE}`)
    process.exit(2)
  }

  // 上一轮留下的 pid 文件会让我们误判「孙进程还活着」
  rmSync(PID_FILE, { force: true })

  const settings: AppSettings = {
    theme: 'dark',
    logBufferLines: 5000,
    minimizeToTray: true,
    autoLaunch: false,
    launchDelayMs: 0,
    fontSize: 12,
    forceColor: true,
    showHiddenCommands: false,
    splitRatio: 0.45,
    logCollapsed: true,
  }

  // 树模型下 ProcessManager 的入参是「已经解析完成的启动规格」。
  // 节点的工作目录由最近的带 path 的祖先分组继承而来（tree.ts 的 resolvePath），
  // 到这一层目录已经是确定的，ProcessManager 不再需要知道树的存在。
  const spec: SpawnSpec = {
    id: ID,
    label: 'fixture',
    command: 'npm run dev',
    cwd: FIXTURE,
    shell: 'cmd',
    expectedPort: PORT,
  }

  /** 模拟渲染进程：把行事件折叠成最终的日志数组 */
  const lines: string[] = []
  const statuses: RuntimeState[] = []
  const exits: ExitInfo[] = []

  const pm = new ProcessManager(settings, {
    onStatus: (s) => statuses.push(s),
    onLog: (_id, events: LineEvent[]) => {
      for (const e of events) {
        if (e.type === 'append') lines.push(e.text)
        else if (lines.length > 0) lines[lines.length - 1] = e.text
        else lines.push(e.text)
      }
    },
    onExit: (info) => exits.push(info),
  })

  // -------------------------------------------------------------------------
  console.log('\n== 启动 ==')

  const started = await pm.start(spec)
  check('start() 立即返回 starting', started.status === 'starting', started.status)

  const running = await waitFor(() => pm.get(ID)?.status === 'running', 25_000)
  const rt = pm.get(ID)
  check('识别到地址信号后切到 running', running, rt?.status ?? '-')
  check('从地址中解析出端口', rt?.detectedPort === PORT, String(rt?.detectedPort))
  check('端口确实在监听', await waitForPort(PORT, 5000))

  // 夹具的进度条要跑 5 × 400ms
  await sleep(3200)

  const all = lines.join('\n')
  check('非 TTY 管道下仍保留 ANSI 颜色', all.includes('\u001b['))
  check('中文未乱码（chcp 65001 生效）', all.includes('中文编码测试：构建成功'))
  check('forceColor 生效且无 NO_COLOR 警告', !all.includes('NO_COLOR'))

  const retained = pm.retainedLog(ID)
  const progressCommitted = retained.filter((l) => l.includes('rendering chunks')).length
  const progressEmitted = lines.filter((l) => l.includes('rendering chunks')).length
  check(
    '\\r 进度条被归一化为覆写，没有堆成 5 行',
    progressCommitted === 0 && progressEmitted <= 1,
    `committed=${progressCommitted} rendered=${progressEmitted}`,
  )
  check('进度条之后的行正常提交', retained.some((l) => l.includes('built in 456ms')))
  check('状态推送是递增的（starting → running）', statuses.length >= 2, `${statuses.length} 次`)

  const shellPid = rt?.pid
  const grandchildPid = Number(readFileSync(PID_FILE, 'utf-8').trim())
  check('捕获到孙进程 pid（模拟 esbuild）', Number.isFinite(grandchildPid) && grandchildPid > 0, String(grandchildPid))
  check('孙进程启动后存活', alive(grandchildPid))

  // -------------------------------------------------------------------------
  console.log('\n== 停止（杀整棵进程树）==')

  await pm.stop(ID)
  await sleep(500)

  check('端口已释放', !(await portOpen(PORT)))
  check('孙进程被 taskkill /T 一并带走', !alive(grandchildPid))
  check('shell 顶层进程已消失', shellPid === undefined || !alive(shellPid))
  check('onExit 标记为「用户主动停止」', exits[0]?.stoppedByUser === true, String(exits[0]?.stoppedByUser))
  check('状态落定为 exited', pm.get(ID)?.status === 'exited', pm.get(ID)?.status ?? '-')

  // -------------------------------------------------------------------------
  console.log('\n== 停止后立刻重启（世代号防护）==')

  await pm.restart(spec)
  const again = await waitFor(() => pm.get(ID)?.status === 'running', 25_000)
  check('重启后重新进入 running', again, pm.get(ID)?.status ?? '-')

  // 旧进程的 exit 事件若没被世代号挡下，会在这段窗口里把新进程标成 exited
  await sleep(1500)
  check('旧进程的退出事件未污染新进程状态', pm.get(ID)?.status === 'running', pm.get(ID)?.status ?? '-')

  // -------------------------------------------------------------------------
  console.log('\n== 重复启动的幂等保护 ==')

  const dup = await pm.start(spec)
  check('对运行中的命令再次 start 被忽略', dup.status === 'running', dup.status)

  // -------------------------------------------------------------------------
  console.log('\n== dispose ==')

  await pm.dispose()
  await sleep(500)
  check('dispose 后端口释放', !(await portOpen(PORT)))
  check('dispose 后孙进程不再存活', !alive(grandchildPid))

  // -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name} [${f.detail}]`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

void main()
