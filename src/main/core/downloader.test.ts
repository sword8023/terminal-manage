import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadError, createProgressThrottle, downloadToFile, type FetchLike } from './downloader.ts'

// ---------------------------------------------------------------------------
// 临时夹具
// ---------------------------------------------------------------------------

/** 每个用例一个独立临时目录，结束后删掉 —— 用例之间不能互相污染 */
async function makeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tm-dl-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 起一个真的本地 http 服务。
 *
 * 用真 socket 而不是假 fetch：重试、断流、chunked 编码这些正是容易写错的地方，
 * 假实现会把它们一起假掉。端口让系统分配，避开 electron.vite.config.ts:48
 * 给渲染进程 dev server 留的 5273（那里 strictPort: true，撞了就是启动失败）。
 */
async function startServer(
  t: test.TestContext,
  handler: (res: ServerResponse, hit: number) => void,
): Promise<{ url: string; hits: () => number }> {
  let hits = 0
  // keepAlive: false 是有意的：默认的长连接会让 undici 的连接池留着一条已经空闲的
  // socket，而下一个用例的临时端口可能正好复用它（端口是系统分配的），于是第一次
  // 请求打在一条对端已关闭的连接上，报一个和被测逻辑毫无关系的 'fetch failed' ——
  // 一个只在整套跑、偶发出现的假失败。让服务端每次都收连接更省事。
  const server = createServer({ keepAlive: false }, (_req, res) => {
    hits += 1
    handler(res, hits)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        // 下载用的是 keep-alive 连接，不主动断开会挂在 close 上
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有拿到监听端口')
  return { url: `http://127.0.0.1:${address.port}/pkg.exe`, hits: () => hits }
}

async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test('下载成功后文件落到目标目录，字节数与 sha256 都对', async (t) => {
  const payload = randomBytes(256 * 1024)
  const sha256 = sha256Of(payload)
  const root = await makeRoot(t)
  const { url } = await startServer(t, (res) => {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  const progress: Array<{ received: number; total: number | null }> = []
  const result = await downloadToFile({
    url,
    targetDir: root,
    fileName: 'pkg.exe',
    expectedSha256: sha256,
    expectedSize: payload.length,
    fetchImpl: fetch,
    onProgress: (info) => progress.push(info),
  })

  assert.equal(result.filePath, join(root, 'pkg.exe'))
  assert.equal(result.bytes, payload.length)
  assert.equal(result.sha256, sha256)
  assert.deepEqual(await listDir(root), ['pkg.exe'])

  const written = await readFile(result.filePath)
  assert.equal(sha256Of(written), sha256)
  assert.equal(written.length, payload.length)

  // 进度是逐块回调的，最后一次必须正好是整包
  const last = progress.at(-1)
  assert.equal(last?.received, payload.length)
  assert.equal(last?.total, payload.length)
})

test('服务端没给 content-length 时 total 为 null（界面显示不确定进度）', async (t) => {
  const payload = randomBytes(64 * 1024)
  const root = await makeRoot(t)
  const { url } = await startServer(t, (res) => {
    // 分两次写 → Node 用 chunked 编码，不带 content-length
    res.write(payload.subarray(0, payload.length / 2))
    res.end(payload.subarray(payload.length / 2))
  })

  const totals: Array<number | null> = []
  await downloadToFile({
    url,
    targetDir: root,
    fileName: 'pkg.exe',
    expectedSha256: sha256Of(payload),
    fetchImpl: fetch,
    onProgress: (info) => totals.push(info.total),
  })

  assert.ok(totals.length > 0)
  assert.deepEqual([...new Set(totals)], [null])
})

// ---------------------------------------------------------------------------
// 校验失败：不可重试，且磁盘上不留任何东西
// ---------------------------------------------------------------------------

test('sha256 不符：抛错、不重试、不留半个文件', async (t) => {
  const payload = randomBytes(32 * 1024)
  const root = await makeRoot(t)
  const server = await startServer(t, (res) => {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  const sleeps: number[] = []
  await assert.rejects(
    downloadToFile({
      url: server.url,
      targetDir: root,
      fileName: 'pkg.exe',
      // 故意给一个错的哈希：包本身没错，但客户端不该接受它
      expectedSha256: sha256Of(Buffer.from('换个人来签这个包')),
      fetchImpl: fetch,
      sleep: async (ms) => void sleeps.push(ms),
    }),
    (err: unknown) => {
      assert.ok(err instanceof DownloadError)
      assert.equal(err.retryable, false)
      assert.match(err.message, /sha256 不符/)
      return true
    },
  )

  assert.equal(server.hits(), 1, '哈希不符不该重试')
  assert.deepEqual(sleeps, [])
  assert.deepEqual(await listDir(root), [])
})

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

test('网络错误按 1s/4s/9s 退避重试，成功即停', async (t) => {
  const payload = randomBytes(4096)
  const root = await makeRoot(t)
  const server = await startServer(t, (res, hit) => {
    if (hit <= 2) {
      // 前两次：服务端自己的问题，值得重试
      res.writeHead(503)
      res.end('busy')
      return
    }
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  const sleeps: number[] = []
  const entries: string[] = []
  const result = await downloadToFile({
    url: server.url,
    targetDir: root,
    fileName: 'pkg.exe',
    expectedSha256: sha256Of(payload),
    fetchImpl: fetch,
    sleep: async (ms) => void sleeps.push(ms),
    log: (message) => entries.push(message),
  })

  assert.equal(result.bytes, payload.length)
  assert.equal(server.hits(), 3)
  assert.deepEqual(sleeps, [1_000, 4_000])
  assert.ok(entries.some((line) => /503/.test(line)), '失败原因要留下痕迹')
})

test('重试次数用尽后抛出最后一次的错误', async (t) => {
  const root = await makeRoot(t)
  const server = await startServer(t, (res) => {
    res.writeHead(500)
    res.end('boom')
  })

  const sleeps: number[] = []
  await assert.rejects(
    downloadToFile({
      url: server.url,
      targetDir: root,
      fileName: 'pkg.exe',
      fetchImpl: fetch,
      sleep: async (ms) => void sleeps.push(ms),
    }),
    /HTTP 500/,
  )

  assert.equal(server.hits(), 4, '一次首发 + 三次重试')
  assert.deepEqual(sleeps, [1_000, 4_000, 9_000])
  assert.deepEqual(await listDir(root), [])
})

test('404 不重试：重试一百次也是同一个答案', async (t) => {
  const root = await makeRoot(t)
  const server = await startServer(t, (res) => {
    res.writeHead(404)
    res.end('nope')
  })

  await assert.rejects(
    downloadToFile({ url: server.url, targetDir: root, fileName: 'pkg.exe', fetchImpl: fetch }),
    /HTTP 404/,
  )
  assert.equal(server.hits(), 1)
})

test('连接被中途切断也会重试', async (t) => {
  const payload = randomBytes(8192)
  const root = await makeRoot(t)
  const server = await startServer(t, (res, hit) => {
    if (hit === 1) {
      // 头都没发完就断：客户端看到的是一次网络错误，而不是一个 HTTP 响应
      res.socket?.destroy()
      return
    }
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  const result = await downloadToFile({
    url: server.url,
    targetDir: root,
    fileName: 'pkg.exe',
    expectedSha256: sha256Of(payload),
    fetchImpl: fetch,
    sleep: async () => undefined,
  })

  assert.equal(result.bytes, payload.length)
  assert.equal(server.hits(), 2)
})

// ---------------------------------------------------------------------------
// 取消与超时
// ---------------------------------------------------------------------------

test('取消下载：抛 cancelled，磁盘上不留文件', async (t) => {
  const payload = randomBytes(64 * 1024)
  const root = await makeRoot(t)
  const server = await startServer(t, (res) => {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.write(payload.subarray(0, 1024))
    // 故意不 end：模拟一个卡在半路的下载
  })

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(
    downloadToFile({
      url: server.url,
      targetDir: root,
      fileName: 'pkg.exe',
      fetchImpl: fetch,
      signal: controller.signal,
    }),
    (err: unknown) => {
      assert.ok(err instanceof DownloadError)
      assert.equal(err.cancelled, true)
      assert.equal(err.retryable, false)
      return true
    },
  )

  assert.deepEqual(await listDir(root), [])
})

test('数据停滞会超时中断，并可按可重试处理', async (t) => {
  const root = await makeRoot(t)
  // 假 fetch：响应头正常，但一个字节都不发。真实现里 abort 会让读取落空，
  // 这里刻意连 abort 都不理会 —— 下载器必须自己从中断信号里挣脱出来
  const silentFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => undefined),
        cancel: async () => undefined,
      }),
    },
  })

  await assert.rejects(
    downloadToFile({
      url: 'http://127.0.0.1:1/pkg.exe',
      targetDir: root,
      fileName: 'pkg.exe',
      fetchImpl: silentFetch,
      stallTimeoutMs: 40,
      retries: 0,
    }),
    (err: unknown) => {
      assert.ok(err instanceof DownloadError)
      assert.match(err.message, /下载超时/)
      assert.equal(err.retryable, true)
      return true
    },
  )
  assert.deepEqual(await listDir(root), [])
})

test('非回环地址的明文 http 一律拒绝', async (t) => {
  const root = await makeRoot(t)
  await assert.rejects(
    downloadToFile({
      url: 'http://example.com/pkg.exe',
      targetDir: root,
      fileName: 'pkg.exe',
      fetchImpl: fetch,
    }),
    /必须是 https/,
  )
})

// ---------------------------------------------------------------------------
// 进度节流
// ---------------------------------------------------------------------------

test('createProgressThrottle：按窗口节流，速率按窗口内增量算', () => {
  let clock = 1_000
  const seen: Array<{ received: number; bytesPerSecond?: number }> = []
  const push = createProgressThrottle((info) => seen.push(info), 100, () => clock)

  push({ received: 0, total: 1_000 }) // 只打点，不发送
  clock = 1_050
  push({ received: 100, total: 1_000 }) // 窗口未满 → 丢弃
  clock = 1_100
  push({ received: 200, total: 1_000 }) // 满 100ms → 发出，速率 = 200 字节 / 0.1s
  clock = 1_150
  push({ received: 300, total: 1_000 }) // 丢弃
  clock = 1_250
  push({ received: 500, total: 1_000 }) // 发出，速率 = 300 字节 / 0.15s

  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0], { received: 200, total: 1_000, bytesPerSecond: 2_000 })
  assert.equal(seen[1]?.received, 500)
  assert.equal(seen[1]?.bytesPerSecond, 2_000)
})
