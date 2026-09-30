/**
 * M0 验证夹具：模拟一个 Vite 风格的 dev server
 *
 * 刻意还原真实项目的三个关键特征，用于验证方案 §4 的各项机制：
 *   1. ANSI 彩色输出   → 验证 FORCE_COLOR 是否在非 TTY 管道下仍生效
 *   2. \r 进度条覆写   → 验证 LineBuffer 的归一化算法
 *   3. 派生子进程      → 验证 taskkill /T 是否真的杀掉整棵进程树
 *   4. 中文输出        → 验证 chcp 65001 是否解决乱码
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 5173
const PID_FILE = path.join(__dirname, '.grandchild.pid')

// 与 chalk / picocolors 相同的判断逻辑：非 TTY 时默认关闭颜色
const useColor = process.env.FORCE_COLOR === '1' || process.stdout.isTTY === true
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

process.stdout.write(
  (useColor ? '\x1b[36m' : '') +
  `[spike] isTTY=${process.stdout.isTTY} FORCE_COLOR=${process.env.FORCE_COLOR ?? '(unset)'} color=${useColor}` +
  (useColor ? '\x1b[0m' : '') + '\n'
)

console.log(c('36', '  VITE v0.0.0-spike  ready in 123 ms'))
console.log('')

// ---- 派生孙进程，模拟 esbuild.exe ----------------------------------------
// 真实进程链：cmd.exe → node(npm) → node(vite) → esbuild.exe
// 只有杀掉整棵树，这个孙进程才会一起消失
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
  stdio: 'ignore',
  windowsHide: true,
})
fs.writeFileSync(PID_FILE, String(grandchild.pid))
console.log(c('90', `  [spike] 已派生孙进程 pid=${grandchild.pid}（模拟 esbuild）`))

// ---- \r 进度条，模拟构建进度 ---------------------------------------------
let i = 0
const timer = setInterval(() => {
  i++
  process.stdout.write(`\r  rendering chunks (${i}/5)...`)
  if (i >= 5) {
    clearInterval(timer)
    process.stdout.write('\r' + ' '.repeat(48) + '\r')
    console.log(c('32', '  ✓ built in 456ms'))
    console.log(c('33', '  中文编码测试：构建成功 🎉'))
  }
}, 400)

// ---- HTTP 服务，用于验证端口监听与释放 -----------------------------------
const server = http.createServer((_req, res) => res.end('spike ok'))
// 真实 Vite 就是在 listening 回调里打印地址的：地址一旦出现，端口必然已经可连。
// 早期版本把地址写在 listen() 之前，导致「就绪」比端口真正绑定早几个 tick。
server.listen(PORT, '127.0.0.1', () => {
  console.log(c('32', '  ➜  Local:   ') + c('36', `http://localhost:${PORT}/`))
  console.log(c('32', '  ➜  Network: ') + c('36', `http://192.168.1.100:${PORT}/`))
  console.log(c('90', `  [spike] listening on http://127.0.0.1:${PORT}`))
})

// 清理：正常 SIGINT 退出时也要带走孙进程
const cleanup = () => {
  try { grandchild.kill() } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
