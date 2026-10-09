/**
 * 更新源的解析、版本比较、地址校验。
 *
 * 全部是纯函数，**刻意不依赖 Electron** —— 和 shared/tree.ts 从 config.ts 里
 * 拆出来是同一个理由：这些逻辑必须能被单测覆盖，而单测跑在裸 node 下
 * （`npm run test:unit`，见 package.json:15），那里既没有 electron
 * 模块、也没有打包器的 `@shared` 别名解析。
 *
 * 所以类型导入一律用 `import type`（node 的类型擦除会整句去掉）。往这个文件里
 * 加一句 `import { net } from 'electron'`，上面的单测就再也跑不起来了。
 */

import type { UpdateAsset, UpdateInfo } from '@shared/types'

/**
 * 内置更新源地址。
 *
 * 留空 = 还没有部署更新源。填上你那个静态目录里 latest.json 的完整地址即可
 * （例如 https://example.com/tm/latest.json）。
 *
 * 不改代码也行：环境变量 `TM_UPDATE_FEED`，或设置里的「更新源」。
 */
export const DEFAULT_FEED_URL = ''

/**
 * latest.json 的 assets 里本平台用的 key。
 *
 * 打包只出 Windows 的 NSIS 安装包，所以是固定值而不是按 arch 拼出来的。
 * 将来若加了别的平台/架构，`scripts/release.mjs`（M4）必须同步改。
 */
export const PLATFORM_KEY = 'win-x64'

/**
 * 认识的协议版本。
 *
 * 将来改协议就 +1：老客户端会明确报「不认识的更新源格式」，
 * 而不是从新格式里解析出半个对象、再以某种没人能解释的方式失败。
 */
const FEED_SCHEMA = 1

interface ParsedVersion {
  core: number[]
  /** prerelease 段，如 1.0.0-rc.1 → ['rc','1']；没有则为空数组 */
  pre: string[]
}

/**
 * 解析 `x.y.z[-prerelease][+build]`。
 *
 * `+build` 整段丢掉：按 semver 它不参与优先级比较，留着只会让
 * `1.0.0+a` 和 `1.0.0+b` 被判成不同版本。
 * 容忍开头的 `v`（git tag 是 `v0.1.0` 而 package.json 是 `0.1.0`）。
 */
function parseVersion(raw: string): ParsedVersion | null {
  const text = (raw.trim().replace(/^v/i, '').split('+')[0] ?? '').trim()
  if (!text) return null

  const dash = text.indexOf('-')
  const head = dash === -1 ? text : text.slice(0, dash)
  const tail = dash === -1 ? '' : text.slice(dash + 1)

  const core: number[] = []
  for (const part of head.split('.')) {
    if (!/^\d+$/.test(part)) return null
    core.push(Number(part))
  }
  if (core.length === 0) return null

  return { core, pre: tail ? tail.split('.').filter((seg) => seg !== '') : [] }
}

function parseVersionOrThrow(raw: string): ParsedVersion {
  const parsed = parseVersion(raw)
  if (!parsed) throw new Error(`版本号格式不对：${raw}`)
  return parsed
}

/**
 * 比较两个版本号：a > b 返回 1，a < b 返回 0 的相反数，相等返回 0。
 *
 * 不能换成 `require('semver-compare')`：node_modules 里确实有它，但那是
 * electron-builder 的**传递依赖**，不会被打进包（electron-builder.yml 的 files
 * 只收 out/** 和 package.json）—— dev 下跑得通、装完启动即崩。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersionOrThrow(a)
  const right = parseVersionOrThrow(b)

  // 核心段数值比较。**不是字符串比较** —— 后者会得出 0.10.0 < 0.2.0。
  // 缺失的段补 0，所以 0.1 与 0.1.0 相等。
  const len = Math.max(left.core.length, right.core.length)
  for (let i = 0; i < len; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }

  // 1.0.0 > 1.0.0-rc.1：有 prerelease 的一律更小
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1

  const preLen = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < preLen; i++) {
    const l = left.pre[i]
    const r = right.pre[i]
    // 短的那个更小：1.0.0-rc < 1.0.0-rc.1
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue

    const ln = /^\d+$/.test(l) ? Number(l) : null
    const rn = /^\d+$/.test(r) ? Number(r) : null
    if (ln !== null && rn !== null) return ln > rn ? 1 : -1
    // 数字段比字母段优先级低：1.0.0-1 < 1.0.0-alpha
    if (ln !== null) return -1
    if (rn !== null) return 1
    return l > r ? 1 : -1
  }
  return 0
}

/**
 * 只允许 https（本机回环与 file 例外）。
 *
 * 这条校验防的是**投毒**：更新源本身是 https，但 feed 里给的包地址是 http。
 * 那一次下载会明文传输一个马上要被执行、而且是静默执行的安装包。
 * 回环地址放行是为了本地端到端测试（spike/update-e2e.mjs）。
 */
export function assertAllowedUrl(raw: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label}不是合法的 URL：${raw}`)
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'file:') return parsed

  const isLoopback =
    parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol === 'http:' && isLoopback) return parsed

  throw new Error(`${label}必须是 https（本机测试可用 http://127.0.0.1）：${raw}`)
}

/**
 * 取出本平台对应的安装包信息。
 *
 * 返回 null 只表示「这个源里根本没有本平台的条目」；条目存在但内容坏了则**抛错**。
 * 区别很重要：把坏条目静默当成「没有更新」，会让一个已经坏掉的发布流程
 * 永远看起来正常 —— 版本发出去了，谁也没收到，而两端都没有任何异常。
 */
export function pickAsset(assets: unknown, key: string): UpdateAsset | null {
  if (assets === null || typeof assets !== 'object') return null

  const entry = (assets as Record<string, unknown>)[key]
  if (entry === undefined || entry === null) return null
  if (typeof entry !== 'object') throw new Error(`更新源里 assets.${key} 不是一个对象`)

  const raw = entry as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  const size =
    typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : 0

  if (!url) throw new Error(`更新源里 assets.${key}.url 缺失`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`更新源里 assets.${key}.sha256 不是 64 位十六进制`)
  }
  assertAllowedUrl(url, '更新包地址')

  return { url, size, sha256 }
}

/**
 * 把 feed 的原始 JSON 解析成一个「可用的更新」。
 *
 * 返回 null = 确实没有更新（版本不高于当前）。除此之外的一切异常都抛出去 ——
 * 这个函数的调用方在渲染层背后，返回 null 在界面上和「已是最新」长得一模一样，
 * 任何被它吞掉的错误都会变成「用户永远收不到新版本」。
 */
export function parseFeed(raw: unknown, current: string): UpdateInfo | null {
  if (raw === null || typeof raw !== 'object') throw new Error('更新源返回的不是一个 JSON 对象')

  const feed = raw as Record<string, unknown>
  if (feed.schema !== FEED_SCHEMA) {
    throw new Error(`不认识的更新源格式（schema=${String(feed.schema)}），请更新本应用`)
  }

  const version = typeof feed.version === 'string' ? feed.version.trim() : ''
  if (!version) throw new Error('更新源里没有 version')
  parseVersionOrThrow(version)

  // 先判版本再要资源：没有更新的时候，缺 win-x64 包不算问题
  if (compareVersions(version, current) <= 0) return null

  const asset = pickAsset(feed.assets, PLATFORM_KEY)
  if (!asset) {
    throw new Error(`更新源声明了新版本 ${version}，但里面没有 ${PLATFORM_KEY} 的安装包`)
  }

  const minVersion = typeof feed.minVersion === 'string' ? feed.minVersion.trim() : ''
  let required = false
  if (minVersion) {
    // minVersion 写坏了不该让整次检查失败：它只影响文案，退回「普通更新」即可
    const parsed = parseVersion(minVersion)
    if (parsed) required = compareVersions(current, minVersion) < 0
  }

  return {
    version,
    notes: typeof feed.notes === 'string' ? feed.notes : undefined,
    publishedAt: typeof feed.publishedAt === 'string' ? feed.publishedAt : undefined,
    required,
    asset,
  }
}

/**
 * 决定这次检查用哪个源，优先级从高到低：
 *
 *   1. 环境变量 `TM_UPDATE_FEED` —— 测试专用，和 TM_USER_DATA / TM_DEBUG 一个思路
 *   2. 设置里的「更新源」
 *   3. 代码内置的 DEFAULT_FEED_URL
 *
 * `env` 做成参数是为了能测：默认值取真实环境变量，单测直接传字符串。
 */
export function resolveFeedUrl(configured: string, env: string | undefined = process.env['TM_UPDATE_FEED']): string {
  const fromEnv = (env ?? '').trim()
  if (fromEnv) return fromEnv
  return configured.trim() || DEFAULT_FEED_URL
}

/**
 * 给 http(s) 的请求加一个一次性参数，绕开缓存。
 *
 * latest.json 是「一个固定路径、内容会变」的资源 —— 这正是 CDN 和 Chromium
 * 缓存策略最爱留住的东西。留着缓存的表现是：新版本发出去几天了，客户端还在
 * 报「已是最新」，而源上一切正常，两端都看不出问题。
 * file: 不加（加了会变成另一个文件名）。
 */
export function withCacheBuster(raw: string, stamp: number): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // 解析不了就原样交给 net.fetch，由它给出更直接的报错
    return raw
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw
  parsed.searchParams.set('t', String(stamp))
  return parsed.href
}

/**
 * 决定安装包在本地的文件名。
 *
 * 优先用源上的文件名（发布方给的名字通常就带着版本号，人一眼能认出来），但它**来自
 * 网络**，会被拼进磁盘路径 —— 所以只留文件名里安全的那几个字符，路径分隔符、
 * 上跳、控制字符在过滤里全部消失。名字不可用（空、非法、后缀不像安装包）时退回
 * 自己拼一个，宁可名字难看，也不能让一个来路不明的文件名决定写到哪里。
 */
export function assetFileName(rawUrl: string, version: string): string {
  const fallback = `Terminal-Manage-${version}-setup.exe`

  let base = ''
  try {
    const parsed = new URL(rawUrl)
    base = parsed.pathname.split('/').pop() ?? ''
    base = decodeURIComponent(base)
  } catch {
    return fallback
  }

  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  if (!safe || !/\.(exe|msi|zip)$/i.test(safe)) return fallback
  return safe
}

/**
 * 第 n 次重试前等多久（n 从 0 起）：1s / 4s / 9s。
 *
 * 用平方而不是翻倍：源挂掉时最不该做的就是几个客户端一起越试越急，
 * 平方增长的间隔能让它在两轮之内就安静下来。
 */
export function backoffDelayMs(attempt: number, baseMs = 1_000): number {
  const step = Math.max(0, Math.trunc(attempt))
  return baseMs * (step + 1) * (step + 1)
}

/**
 * 这个 HTTP 状态码值不值得重试。
 *
 * 5xx 是服务端自己的问题；408 和 429 是明确的「稍后再来」。其余 4xx 都是
 * 「你要的东西不在这儿 / 你没权限」—— 重试一百次也是同一个答案。
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}
