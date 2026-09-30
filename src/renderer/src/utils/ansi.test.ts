import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastUrl, toHtml } from './ansi.ts'

/* ------------------------------------------------- URL 变成可点元素 */

test('普通 URL 变成带 data-url 的锚点', () => {
  const html = toHtml('  ➜  Local:   http://localhost:5173/')
  assert.match(html, /<a class="log-link" data-url="http:\/\/localhost:5173\/"/)
  assert.match(html, />http:\/\/localhost:5173\/<\/a>/)
})

/**
 * 只看「真的标签内部」有没有 href。
 *
 * 不能简单写 `!/\shref=/`：被转义的纯文本长这样 —— `&lt;a href=&quot;…`，
 * 里面那个 ` href=` 是文字内容，不是属性。所以要连前面的 `<tag` 一起要求。
 */
const REAL_HREF = /<[a-z][^>]*\shref=/i

test('锚点用 data-url 而不是 href —— 真 href 会把整个应用窗口导航走', () => {
  assert.ok(!REAL_HREF.test(toHtml('see https://example.com/a')))
})

test('行尾标点不算 URL 的一部分', () => {
  const html = toHtml('打开 http://localhost:5173/.')
  assert.match(html, /data-url="http:\/\/localhost:5173\/"/)
  assert.match(html, /<\/a>\.$/)
})

test('查询串里的真 & 在属性里转义', () => {
  const html = toHtml('http://x.test/?a=1&b=2')
  assert.match(html, /data-url="http:\/\/x\.test\/\?a=1&amp;b=2"/)
  // 可见文本保持转义形态，浏览器渲染出来才是 &
  assert.match(html, />http:\/\/x\.test\/\?a=1&amp;b=2<\/a>/)
})

test('非 http(s) 协议不变成锚点', () => {
  for (const bad of ['javascript:alert(1)', 'file:///C:/windows/win.ini', 'ms-settings:']) {
    assert.ok(!toHtml(`x ${bad}`).includes('log-link'), `${bad} 不该被链接化`)
  }
})

test('ANSI 着色不阻止 URL 被识别，且标签片段一个字不动', () => {
  const html = toHtml('\u001b[36mhttp://localhost:5173/\u001b[0m')
  assert.match(html, /^<span[^>]*><a class="log-link"/)
  assert.match(html, /<\/a><\/span>$/)
})

test('夹在着色片段之间的 URL 也能被单独识别', () => {
  const html = toHtml('\u001b[32mok\u001b[0m http://a.test/ \u001b[31mfail\u001b[0m')
  assert.match(html, /<a class="log-link" data-url="http:\/\/a\.test\/"/)
  assert.match(html, /fail/)
})

test('没有 URL 的行原样返回', () => {
  const html = toHtml('\u001b[32m  ready in 320 ms\u001b[0m')
  assert.ok(!html.includes('log-link'))
  assert.match(html, /ready in 320 ms/)
})

/* ------------------------------------------------------- 安全边界 */

test('日志内容里的 HTML 一律转义，注入不出元素', () => {
  const html = toHtml('<img src=x onerror="alert(1)">')
  assert.ok(!html.includes('<img'), html)
  assert.match(html, /&lt;img/)
})

test('被转义的 <a href="javascript:…"> 仍是纯文本，也不会多出锚点', () => {
  const html = toHtml('<a href="javascript:alert(1)">x</a>')
  assert.match(html, /&lt;a href=/)
  assert.ok(!REAL_HREF.test(html), '不能拼出真的 href 属性')
  assert.ok(!html.includes('log-link'))
})

test('被转义的 <a href="http://…"> 只多出一个 data-url 锚点', () => {
  const html = toHtml('<a href="http://evil.test/">x</a>')
  assert.match(html, /&lt;a href=/)
  assert.ok(html.includes('log-link'))
  assert.ok(!REAL_HREF.test(html), '不能拼出真的 href 属性')
})

test('URL 后面跟着被转义的尖括号时，不会把尾巴一起吃进锚点', () => {
  const html = toHtml('http://a.test/x"><script>alert(1)</script>')
  assert.ok(!html.includes('<script'), html)
  assert.match(html, /data-url="http:\/\/a\.test\/x"/)
  assert.match(html, /&lt;script&gt;/)
})

/* ------------------------------------------------------------ lastUrl */

test('lastUrl 取最后一个链接', () => {
  assert.equal(lastUrl('a http://one.test/ b http://two.test/x'), 'http://two.test/x')
})

test('lastUrl 没有链接时是 null', () => {
  assert.equal(lastUrl('nothing here'), null)
})

test('lastUrl 同样去掉行尾标点', () => {
  assert.equal(lastUrl('打开 http://localhost:5173/。'), 'http://localhost:5173/')
})

test('lastUrl 连续调用互不干扰（共享正则不能留下 lastIndex 状态）', () => {
  assert.equal(lastUrl('一 http://a.test/'), 'http://a.test/')
  assert.equal(lastUrl('二 http://b.test/'), 'http://b.test/')
})

/* ------------------------------------------- 原始文本里的控制序列 / 非 ASCII */

test('lastUrl 剥掉尾部控制序列 —— 带色的那一行不能把还原序列吃进地址', () => {
  // Vite 把地址本身染成青色，所以传进来的是原始文本：
  //   `  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m`
  // 不剥就是把 `\u001b[39m` 算作地址的一部分。这种地址界面上看不出任何异常
  // （控制字符不显示也不占宽），交给系统浏览器却只会被拒绝打开。
  assert.equal(
    lastUrl('  \u279c  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m'),
    'http://localhost:5173/',
  )
})

test('地址后面紧贴中文时，中文不算地址的一部分', () => {
  // 行尾标点那套规则只认得 ASCII 与中文标点，接一整串汉字则够不着
  assert.equal(lastUrl('请访问 http://localhost:5173/查看详情'), 'http://localhost:5173/')
  const html = toHtml('请访问 http://localhost:5173/查看详情')
  assert.match(html, /data-url="http:\/\/localhost:5173\/"/)
  assert.match(html, /<\/a>查看详情$/)
})

test('OSC 8 超链接：地址藏在序列里，显示文本不会被粘进地址', () => {
  // `ESC ] 8 ; 参数 ; URL ST` 包住要显示的文本。通用的 OSC 剥离会把地址一起删掉，
  // 而这里要的恰恰是它；反过来只留地址，紧跟其后的显示文本又会粘出一个假路径
  // （`http://localhost:5173/Local`）。
  const line = '\u001b]8;;http://localhost:5173/\u001b\\Local\u001b]8;;\u001b\\'
  assert.equal(lastUrl(line), 'http://localhost:5173/')
  assert.match(toHtml(line), /data-url="http:\/\/localhost:5173\/"/)
})

test('其余 OSC（改窗口标题那种）不落进 DOM', () => {
  const html = toHtml('\u001b]0;my title\u0007ready http://a.test/')
  assert.match(html, /data-url="http:\/\/a\.test\/"/)
  assert.ok(!html.includes('my title'), html)
})
