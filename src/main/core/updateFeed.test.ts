import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FEED_URL,
  assertAllowedUrl,
  compareVersions,
  parseFeed,
  resolveFeedUrl,
  withCacheBuster,
} from './updateFeed.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(64)

/** 一份结构正确的 feed，各用例只覆盖自己关心的那几个字段 */
function feed(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    version: '0.1.1',
    assets: {
      'win-x64': {
        url: 'https://example.com/tm/Terminal-Manage-0.1.1-setup.exe',
        size: 1024,
        sha256: SHA,
      },
    },
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

test('compareVersions：按数值比较，而不是按字符串', () => {
  // 这两条是同一个陷阱的两面：字符串比 "0.10.0" < "0.2.0"（'1' < '2'），
  // 数值比才是 0.10.0 > 0.2.0。写反了的表现是 0.10.0 发布之后，所有 0.2.0
  // 的用户永远收不到更新。
  assert.equal(compareVersions('0.10.0', '0.2.0'), 1)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)

  assert.equal(compareVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
})

test('compareVersions：prerelease 一律小于同版本的正式版', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  // prerelease 内部同样是数值比较
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  // 段少的更小：rc < rc.1
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1)
  // 数字段比字母段优先级低
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
})

test('compareVersions：缺失段补 0，build 元数据不参与比较', () => {
  assert.equal(compareVersions('0.1', '0.1.0'), 0)
  assert.equal(compareVersions('0.1.0+build.5', '0.1.0'), 0)
  // git tag 是 v0.1.0，package.json 里是 0.1.0 —— 两边都要能读
  assert.equal(compareVersions('v0.2.0', '0.1.0'), 1)
})

test('compareVersions：版本号写坏就抛，不猜一个结果出来', () => {
  assert.throws(() => compareVersions('abc', '0.1.0'), /版本号格式不对/)
  assert.throws(() => compareVersions('0.1.0', ''), /版本号格式不对/)
  assert.throws(() => compareVersions('0.1.x', '0.1.0'), /版本号格式不对/)
})

// ---------------------------------------------------------------------------
// feed 解析
// ---------------------------------------------------------------------------

test('parseFeed：版本更高才算有更新', () => {
  const info = parseFeed(feed(), '0.1.0')
  assert.ok(info)
  assert.equal(info.version, '0.1.1')
  assert.equal(info.required, false)
  assert.equal(info.asset.size, 1024)
  assert.equal(info.asset.sha256, SHA)
})

test('parseFeed：同版本与更低版本都返回 null（对界面而言就是「已是最新」）', () => {
  assert.equal(parseFeed(feed({ version: '0.1.0' }), '0.1.0'), null)
  assert.equal(parseFeed(feed({ version: '0.0.9' }), '0.1.0'), null)
})

test('parseFeed：minVersion 高于当前版本时标记为必须升级', () => {
  assert.equal(parseFeed(feed({ minVersion: '0.1.2' }), '0.1.0')?.required, true)
  assert.equal(parseFeed(feed({ minVersion: '0.0.1' }), '0.1.0')?.required, false)
})

test('parseFeed：minVersion 写坏了只退回普通更新，不让整次检查失败', () => {
  // 它只影响一句文案，没有理由因此连更新都做不了
  assert.equal(parseFeed(feed({ minVersion: '最新版' }), '0.1.0')?.required, false)
})

test('parseFeed：notes 与 publishedAt 是可选字段', () => {
  const withNotes = parseFeed(feed({ notes: '修复滚动位置', publishedAt: '2026-02-01T00:00:00Z' }), '0.1.0')
  assert.equal(withNotes?.notes, '修复滚动位置')
  assert.equal(withNotes?.publishedAt, '2026-02-01T00:00:00Z')

  const without = parseFeed(feed(), '0.1.0')
  assert.equal(without?.notes, undefined)
})

test('parseFeed：不认识的 schema 直接抛', () => {
  assert.throws(() => parseFeed(feed({ schema: 2 }), '0.1.0'), /不认识的更新源格式/)
  assert.throws(() => parseFeed(feed({ schema: undefined }), '0.1.0'), /不认识的更新源格式/)
})

test('parseFeed：不是对象就抛', () => {
  assert.throws(() => parseFeed('{}', '0.1.0'), /不是一个 JSON 对象/)
  assert.throws(() => parseFeed(null, '0.1.0'), /不是一个 JSON 对象/)
})

test('parseFeed：没有 version、或 version 是垃圾，都抛', () => {
  // 静默当成「已是最新」的话，一个永远发不出去的版本会看起来一切正常
  assert.throws(() => parseFeed(feed({ version: undefined }), '0.1.0'), /没有 version/)
  assert.throws(() => parseFeed(feed({ version: '   ' }), '0.1.0'), /没有 version/)
  assert.throws(() => parseFeed(feed({ version: 'next' }), '0.1.0'), /版本号格式不对/)
})

test('parseFeed：声明了新版本却没有本平台的包 —— 这是发布流程坏了，必须抛', () => {
  assert.throws(() => parseFeed(feed({ assets: {} }), '0.1.0'), /没有 win-x64 的安装包/)
  // 但没有更新的时候，缺包不算问题：这里根本不该走到资源检查
  assert.equal(parseFeed(feed({ assets: {}, version: '0.1.0' }), '0.1.0'), null)
})

test('parseFeed：sha256 不是 64 位十六进制就抛', () => {
  const bad = feed({
    assets: { 'win-x64': { url: 'https://example.com/a.exe', size: 1, sha256: 'zz' } },
  })
  assert.throws(() => parseFeed(bad, '0.1.0'), /sha256/)

  const upper = feed({
    assets: { 'win-x64': { url: 'https://example.com/a.exe', size: 1, sha256: SHA.toUpperCase() } },
  })
  // 大写要能接受：它是同一个值，只是写的人大小写不同 —— 但比对时统一成小写
  assert.equal(parseFeed(upper, '0.1.0')?.asset.sha256, SHA)
})

test('parseFeed：缺 url 就抛', () => {
  const bad = feed({ assets: { 'win-x64': { size: 1, sha256: SHA } } })
  assert.throws(() => parseFeed(bad, '0.1.0'), /url 缺失/)
})

// ---------------------------------------------------------------------------
// 地址白名单
// ---------------------------------------------------------------------------

test('assertAllowedUrl：只放行 https、file 与本机回环', () => {
  assert.equal(assertAllowedUrl('https://example.com/a.exe', '更新包地址').protocol, 'https:')
  assert.equal(assertAllowedUrl('file:///C:/tm/a.exe', '更新包地址').protocol, 'file:')
  assert.equal(assertAllowedUrl('http://127.0.0.1:5274/a.exe', '更新包地址').protocol, 'http:')
  assert.equal(assertAllowedUrl('http://localhost:5274/a.exe', '更新包地址').protocol, 'http:')

  assert.throws(() => assertAllowedUrl('http://example.com/a.exe', '更新包地址'), /必须是 https/)
  assert.throws(() => assertAllowedUrl('ftp://example.com/a.exe', '更新包地址'), /必须是 https/)
  assert.throws(() => assertAllowedUrl('不是一个地址', '更新包地址'), /不是合法的 URL/)
})

test('parseFeed：feed 把包地址写成明文 http 时，整次检查失败', () => {
  // 这是本模块最重要的一条防线：源本身是 https，但包地址是 http ——
  // 那一次下载会明文传一个马上要被静默执行的安装包
  const poisoned = feed({
    assets: { 'win-x64': { url: 'http://example.com/a.exe', size: 1, sha256: SHA } },
  })
  assert.throws(() => parseFeed(poisoned, '0.1.0'), /必须是 https/)
})

// ---------------------------------------------------------------------------
// 源的来源
// ---------------------------------------------------------------------------

test('resolveFeedUrl：环境变量 > 设置 > 内置', () => {
  assert.equal(
    resolveFeedUrl('https://settings/latest.json', 'https://env/latest.json'),
    'https://env/latest.json',
  )
  assert.equal(resolveFeedUrl('https://settings/latest.json', ''), 'https://settings/latest.json')
  assert.equal(resolveFeedUrl('https://settings/latest.json'), 'https://settings/latest.json')
})

test('resolveFeedUrl：只有空白等于没填', () => {
  assert.equal(resolveFeedUrl('   ', '   '), DEFAULT_FEED_URL)
  assert.equal(resolveFeedUrl('  https://settings/x.json  ', undefined), 'https://settings/x.json')
})

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

test('withCacheBuster：http(s) 加一次性参数，其余原样', () => {
  assert.equal(withCacheBuster('https://e.com/latest.json', 123), 'https://e.com/latest.json?t=123')
  assert.equal(withCacheBuster('https://e.com/latest.json?a=1', 123), 'https://e.com/latest.json?a=1&t=123')
  assert.equal(withCacheBuster('file:///C:/tm/latest.json', 123), 'file:///C:/tm/latest.json')
  assert.equal(withCacheBuster('不是一个地址', 123), '不是一个地址')
})
