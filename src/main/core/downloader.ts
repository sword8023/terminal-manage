/**
 * 安装包下载器。
 *
 * 和 `updateFeed.ts` 同一个理由**刻意不依赖 Electron**：这里的每一行都要能被单测
 * 覆盖（起一个真 http 服务、喂真字节、验真哈希），而单测跑在裸 node 下
 * （`npm run test:unit`）。所以网络函数由调用方注入 —— 生产环境传 Electron 的
 * `net.fetch`（见 Updater.ts），这个模块自己不认识 electron。
 *
 * 不实现断点续传：哈希是从第一个字节开始流式算的，要续传就得把已经落盘的 .part
 * 重读一遍喂给哈希才能接着算，正确性很容易写错；而重下一次 106 MB 的代价可以接受。
 * 每次重试都从头下，磁盘上不留半成品。
 */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
// 带 .ts 后缀是必需的，不是笔误：本模块要被 `npm run test:unit` 用裸 node 直接加载
// （`node --test src/**/*.test.ts`，零构建），而 node 的 ESM 解析器不做扩展名补全 ——
// 写成 './updateFeed' 会 ERR_MODULE_NOT_FOUND。仓库里其余生产模块都走打包器解析，
// 只有这里和在测试里直接 import 的模块需要写出后缀。
import { assertAllowedUrl, backoffDelayMs, isRetryableStatus } from './updateFeed.ts'

/**
 * `net.fetch` 的 Response 里我们真正用到的那几项。
 *
 * 写成结构化类型而不是 `Response`，是为了让单测能塞一个假实现进来
 * （真 `Response` 也行，它天然满足这个形状）。
 */
export interface ResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  /** WHATWG ReadableStream（`net.fetch` 的 `res.body`）；用 unknown 让假实现也能塞进来 */
  body: unknown
}

export type FetchLike = (
  url: string,
  init?: { redirect?: 'follow'; signal?: AbortSignal },
) => Promise<ResponseLike>

export interface ProgressInfo {
  received: number
  /** 总字节数；服务端没给 content-length 时为 null（界面显示不确定进度条） */
  total: number | null
}

/**
 * 下载失败的原因分了类，因为两类失败的处置完全不同：
 *  - **可重试**：连接被拒、5xx、中途断流 —— 再试一次通常就好了
 *  - **不可重试**：sha256 不符、用户取消 —— 重试毫无意义
 *    （哈希不符意味着包本身或链路上有人在改字节，反复重下只会反复失败）
 */
export class DownloadError extends Error {
  readonly retryable: boolean
  readonly cancelled: boolean

  constructor(message: string, options: { retryable?: boolean; cancelled?: boolean } = {}) {
    super(message)
    this.name = 'DownloadError'
    this.retryable = options.retryable ?? false
    this.cancelled = options.cancelled ?? false
  }
}

export interface DownloadRequest {
  url: string
  /** 落盘目录，如 `<userData>/updates/0.1.1` */
  targetDir: string
  fileName: string
  /** 期望的 sha256（小写十六进制）。给了就必校验，不符一律作废 */
  expectedSha256?: string
  /** feed 里声明的字节数，用于进度条与完整性核查 */
  expectedSize?: number
  fetchImpl: FetchLike
  /** 外部取消（渲染层点「取消」） */
  signal?: AbortSignal
  /** 多久没收到新数据算超时。注意**不是**整包超时：106 MB 在慢网上下十分钟很正常 */
  stallTimeoutMs?: number
  /** 网络错误的重试次数；退避 1s / 4s / 9s。哈希不符不重试 */
  retries?: number
  onProgress?: (info: ProgressInfo) => void
  log?: (message: string) => void
  /** 重试前的等待；注入以便测试跳过真实等待 */
  sleep?: (ms: number) => Promise<void>
}

export interface DownloadResult {
  /** 校验通过、已经从 .part 改名过来的最终路径 */
  filePath: string
  bytes: number
  sha256: string
}

const DEFAULT_STALL_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

/**
 * 把下载进度压到 ~10 Hz 再往外发。
 *
 * 106 MB 的包会触发上万次分片回调，每次都走一遍 IPC + Vue 响应式更新足以把渲染进程
 * 压垮。思路与 `LogBatcher` 相同（开一个聚合窗口），区别是进度只有「最新值」有意义，
 * 不需要队列 —— 中间那些值过期即弃。
 *
 * 速率按**窗口内增量**算而不是全程平均：全程平均在网络变慢时几乎不下降，
 * 界面上看起来就像卡死了，恰恰丢掉了用户最需要的信息。
 */
export function createProgressThrottle(
  emit: (info: ProgressInfo & { bytesPerSecond?: number }) => void,
  intervalMs = 100,
  now: () => number = Date.now,
): (info: ProgressInfo) => void {
  let lastAt = 0
  let lastBytes = 0

  return (info) => {
    const at = now()
    // 第一次调用只用来打点，不发送：此时样本窗口还没有长度，算不出速率
    if (lastAt === 0) {
      lastAt = at
      lastBytes = 0
      return
    }
    if (at - lastAt < intervalMs) return

    const seconds = (at - lastAt) / 1000
    const delta = info.received - lastBytes
    lastAt = at
    lastBytes = info.received
    emit({ ...info, bytesPerSecond: seconds > 0 ? Math.round(delta / seconds) : undefined })
  }
}

/**
 * 下载并校验一个安装包。
 *
 * 原子性沿用 `ConfigStore.save()` 的思路：先写 `<名字>.part`，全部校验通过才
 * `rename` 成正式名字。于是「磁盘上有这个文件」就等于「它能用」——
 * `.part` 这个名字本身就是给外部看的「别用我」标记。
 */
export async function downloadToFile(request: DownloadRequest): Promise<DownloadResult> {
  assertAllowedUrl(request.url, '更新包地址')

  const retries = request.retries ?? DEFAULT_RETRIES
  const sleep =
    request.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  await mkdir(request.targetDir, { recursive: true })
  const finalPath = join(request.targetDir, request.fileName)
  const partPath = `${finalPath}.part`

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelayMs(attempt - 1)
      request.log?.(
        `下载失败（${lastError?.message ?? '未知原因'}），${delay} 毫秒后重试（第 ${attempt}/${retries} 次）`,
      )
      await sleep(delay)
    }
    try {
      return await attemptDownload(request, partPath, finalPath)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      lastError = error
      const retryable = error instanceof DownloadError && error.retryable
      if (!retryable || attempt === retries) throw error
    }
  }
  throw lastError ?? new Error('下载失败')
}

async function attemptDownload(
  request: DownloadRequest,
  partPath: string,
  finalPath: string,
): Promise<DownloadResult> {
  // 上一次失败留下的半个文件不可信，而且必须先清掉才能重下
  await rm(partPath, { force: true })

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) controller.abort()

  const stallMs = request.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  let stallTimer: NodeJS.Timeout | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(abort, stallMs)
  }
  const disarm = (): void => {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }

  const hash = createHash('sha256')
  let received = 0
  let total: number | null =
    request.expectedSize && request.expectedSize > 0 ? request.expectedSize : null

  try {
    armStall()
    const res = await request.fetchImpl(request.url, {
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new DownloadError(`更新源返回 HTTP ${res.status}`, {
        retryable: isRetryableStatus(res.status),
      })
    }

    const fromHeader = Number(res.headers.get('content-length'))
    if (Number.isFinite(fromHeader) && fromHeader > 0) total = fromHeader

    if (!res.body) throw new DownloadError('更新源没有返回内容', { retryable: true })
    const reader = getReader(res.body)

    const file = createWriteStream(partPath)
    try {
      for (;;) {
        const { done, value } = await readChunk(reader, controller.signal)
        if (done) break
        if (!value || value.length === 0) continue

        // 有数据进来就重新计时：卡住和慢是两回事，慢不该被超时打断
        armStall()
        received += value.length
        hash.update(value)
        // write 返回 false 表示内部缓冲满了，等它排空再继续，否则内存会一路涨上去
        if (!file.write(value)) await once(file, 'drain')
        request.onProgress?.({ received, total })
      }
      file.end()
      await once(file, 'finish')
    } catch (err) {
      file.destroy()
      throw err
    }

    const sha256 = hash.digest('hex')
    if (request.expectedSha256 && sha256 !== request.expectedSha256.toLowerCase()) {
      throw new DownloadError(
        `安装包校验失败：sha256 不符（期望 ${request.expectedSha256}，实际 ${sha256}）`,
      )
    }
    // 只查「少了」，不查「多了」：服务端对文本可能开 gzip，content-length 是压缩后的
    // 长度，读出来却是解压后的字节数。少了必然是断流，多了交给上面的哈希说话
    if (total !== null && received < total) {
      throw new DownloadError(`下载不完整：期望 ${total} 字节，只收到 ${received} 字节`, {
        retryable: true,
      })
    }

    await rename(partPath, finalPath)
    return { filePath: finalPath, bytes: received, sha256 }
  } catch (err) {
    // 失败绝不留下半成品：宁可下次重下，也不能让一个残缺的安装包有机会被执行
    await rm(partPath, { force: true }).catch(() => undefined)

    if (err instanceof DownloadError && !err.retryable) throw err
    if (request.signal?.aborted) throw new DownloadError('已取消下载', { cancelled: true })
    if (controller.signal.aborted) {
      throw new DownloadError(`下载超时（${stallMs} 毫秒没有收到数据）`, { retryable: true })
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new DownloadError(`下载失败：${message}`, { retryable: true })
  } finally {
    disarm()
    request.signal?.removeEventListener('abort', abort)
  }
}

/**
 * 从响应体上取 reader。
 *
 * 类型收敛只在这一处：`res.body` 声明的类型是 `unknown`（这样 Electron 的 Response
 * 和单测里的假响应都塞得进来），真正用到的时候才按 WHATWG 的形状取一次。
 * 形状不对说明对方回的不是一个流，属于网络侧的问题，按可重试处理。
 */
function getReader(body: unknown): { read(): Promise<{ done: boolean; value?: Uint8Array }> } {
  const stream = body as {
    getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> }
  }
  if (typeof stream.getReader !== 'function') {
    throw new DownloadError('更新源返回的内容读不出来（不是数据流）', { retryable: true })
  }
  return stream.getReader()
}

/**
 * 等下一块数据，同时盯着中断信号。
 *
 * 不能只依赖「abort 会让流自己报错」：真实现里通常如此，但那是行为而不是保证 ——
 * 只要有一条路径上读取永远不落空，超时和取消就都成了摆设：下载一直挂着，状态机
 * 停在 downloading，用户连重试的机会都没有。所以这里用 Promise.race 把中断信号
 * 也当成一个「读取结果」。
 */
async function readChunk(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) throw new DownloadError('下载已中断', { cancelled: true })

  let onAbort: (() => void) | null = null
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DownloadError('下载已中断', { retryable: true }))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
