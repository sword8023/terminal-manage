/**
 * M0 可行性验证脚本 —— 方案 §4.1 / §4.3 的地基验证
 *
 * 验证四件事：
 *   [1] ANSI 颜色在管道（非 TTY）下是否保留 —— 决定 FORCE_COLOR 方案是否成立
 *   [2] \r 覆写字符是否出现在输出流中      —— 决定 LineBuffer 是否必要
 *   [3] chcp 65001 是否解决中文乱码
 *   [4] ★ taskkill /T 是否真正杀掉整棵进程树（端口释放 + 孙进程死亡）
 *
 * 用法：node spike/spike.mjs
 * 退出码：0 = 全部通过，1 = 有失败项
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixture')
const PID_FILE = path.join(FIXTURE, '.grandchild.pid')
const PORT = 5173

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isPortInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' })
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(500, () => done(false))
  })
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true
    await sleep(300)
  }
  return false
}

async function taskkillTree(pid) {
  return new Promise((resolve) => {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      .on('close', (code) => resolve(code))
  })
}

// =========================================================================
console.log('\n=== M0 可行性验证 ===')
console.log(`夹具目录: ${FIXTURE}\n`)

if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE)

const rawChunks = []
const child = spawn('cmd.exe', ['/c', 'chcp 65001 >nul && npm run dev'], {
  cwd: FIXTURE,
  env: { ...process.env, FORCE_COLOR: '1' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const collect = (tag) => (buf) => {
  const text = buf.toString('utf8')
  rawChunks.push({ tag, text })
  process.stdout.write(`[${tag}] ${text}`)
}
child.stdout.on('data', collect('OUT'))
child.stderr.on('data', collect('ERR'))

console.log('--- 进程已派生，等待服务就绪 ---\n')
const up = await waitForPort(PORT)
const pidShown = child.pid

if (!up) {
  console.log('\n❌ 服务未在超时时间内监听端口，后续验证无法进行')
  console.log('   （若为 spawn/EPERM 失败，说明沙箱仍在拦截管道的 stdio）')
  await taskkillTree(pidShown)
  process.exit(1)
}

await sleep(2500) // 等 \r 进度条跑完

const all = rawChunks.map((c) => c.text).join('')

console.log('\n--- 静态检查 ---')
record('ANSI 颜色在管道下保留', all.includes('\x1b['),
  all.includes('\x1b[') ? '输出含 ESC 序列，FORCE_COLOR 生效' : '无 ESC 序列，颜色被丢弃')

record('\\r 覆写字符存在', all.includes('\r'),
  all.includes('\r') ? '存在 \\r，LineBuffer 归一化必要' : '未观察到 \\r')

record('中文未乱码', all.includes('中文编码测试') && all.includes('构建成功'),
  all.includes('中文编码测试') ? 'chcp 65001 生效' : '中文丢失或乱码')

// ---- 核心验证：进程树 ------------------------------------------------
console.log('\n--- 核心验证：进程树终止 ---')
const grandchildPid = fs.existsSync(PID_FILE)
  ? Number(fs.readFileSync(PID_FILE, 'utf8').trim())
  : null

record('捕获到孙进程 pid', Number.isInteger(grandchildPid),
  grandchildPid ? `pid=${grandchildPid}` : '未写入 pid 文件')
record('启动后端口处于监听', await isPortInUse(PORT), `port ${PORT}`)
record('启动后孙进程存活', grandchildPid ? isAlive(grandchildPid) : false,
  grandchildPid ? `pid=${grandchildPid}` : '—')

console.log(`\n--- 执行 taskkill /PID ${pidShown} /T /F ---`)
const killCode = await taskkillTree(pidShown)
console.log(`taskkill 退出码: ${killCode}\n`)
await sleep(2000)

const portAfter = await isPortInUse(PORT)
const grandchildAfter = grandchildPid ? isAlive(grandchildPid) : null

record('★ 端口已释放', !portAfter, portAfter ? `port ${PORT} 仍被占用` : `port ${PORT} 已释放`)
record('★ 孙进程已终止', grandchildAfter === false,
  grandchildAfter === null ? '—' : (grandchildAfter ? '孙进程仍存活（进程树未杀净）' : '孙进程已死'))

// ---- 汇总 -------------------------------------------------------------
const failed = results.filter((r) => !r.pass)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) {
  console.log('\n❌ 失败项：')
  for (const f of failed) console.log(`   · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  console.log('\n方案 §4.1 的进程树假设未通过验证，架构需要重新评估。')
  process.exit(1)
} else {
  console.log('\n✅ M0 全部通过：方案 §4 的核心假设成立，可以进入 M1。')
  process.exit(0)
}
