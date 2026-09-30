/**
 * 第二个夹具项目的 dev server。
 *
 * 存在的理由：界面探针里「移动到…」等断言要求 seed 出来的同级分组至少有两个
 * （它只在这两个分组之间搬运命令），所以仓库必须自带两个项目目录。
 *
 * 刻意写得比 fixture/server.mjs 干净 —— 那一个负责验证进程树击杀、\r 覆写、
 * ANSI 颜色，这一个只需要「是一个看起来正常的 Vite 项目」。
 */
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 5174)

console.log('  VITE v0.0.0-fixture  ready in 210 ms')
console.log('')

const server = http.createServer((_req, res) => res.end('fixture-web ok'))

// 和真实 Vite 一样，地址在 listening 回调里打印：地址一旦出现，端口必然可连。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`  ➜  Local:   http://localhost:${PORT}/`)
  console.log(`  ➜  Network: http://192.168.1.100:${PORT}/`)
})
