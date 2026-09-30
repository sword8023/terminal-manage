import { AnsiUp } from 'ansi_up'

const ansi = new AnsiUp()

/**
 * 开启 HTML 转义 —— 这一行是安全边界，不能删。
 *
 * 日志内容最终通过 v-html 注入 DOM，而 dev server 的输出里可以出现任何字符
 * （构建报错里回显的文件名、接口返回的 JSON……）。不转义就等于把 XSS 能力
 * 交给了被监控的那个进程。ansi_up 默认 escape_html = false。
 */
ansi.escape_html = true

/**
 * 用 CSS class 而不是内联样式。
 *
 * ANSI 的 "black" 是纯黑，直接内联到深色背景上等于隐形；换成 class 后
 * 可以在 styles.css 里把整套 16 色重映射成适合深色主题的调色板。
 */
ansi.use_classes = true

const FALLBACK: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/* ------------------------------------------------------------ 日志里的链接 */

/**
 * 控制序列。
 *
 * 链接提取跑在**原始文本**上（渲染那条路走的是 ansi_up 转出来的 HTML，转义早已
 * 变成标签，不受影响），而日志里带色是常态 —— Vite 把地址本身染成青色，那一行
 * 实际长这样：
 *
 *     `  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m`
 *
 * 不先剥掉还原序列，`\u001b[39m` 会被算作地址的一部分，末尾挂上一串控制字符。
 * 这种地址交给系统浏览器只会被拒绝打开，而界面上又完全看不出来 —— 控制字符不占
 * 宽度也不显示，用户看到的仍然是一个正常的地址，点了却没反应。
 */
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g

/**
 * OSC 8 超链接：`ESC ] 8 ; 参数 ; URL ST` 包住要显示的文本，地址藏在序列里。
 *
 * 它得单独处理 —— 通用的 OSC 剥离会连地址一起删掉，而这里要的恰恰是那个地址，
 * 所以替换成 `$1` 把它变回普通文本，交给后面的 URL_RE 正常识别。
 */
const OSC8_RE = /\u001b\]8;[^;]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)?/g

/** 其余 OSC（改标题、改光标形状……）：终端之外没有意义，直接删 */
const OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g

/**
 * 剥掉 OSC，**不动 CSI** —— 后者是上色用的，得原样留给 ansi_up。
 *
 * 展开成「地址 + 空格」而不是只留地址：OSC 8 后面紧跟着的是它包住的显示文本，
 * 两者之间本来没有分隔符。不留这个空格，`…/` 会和显示文本粘成一个地址
 * （`http://localhost:5173/Local`）。
 */
function stripOsc(text: string): string {
  return text.replace(OSC8_RE, '$1 ').replace(OSC_RE, '')
}

function stripAnsi(text: string): string {
  return stripOsc(text).replace(CSI_RE, '')
}

/**
 * 只认 http(s)。
 *
 * 与主进程 `shell:openUrl` 的白名单同源：日志来自被监控的进程，里面出现什么
 * 协议都不奇怪，而 `shell.openExternal` 会把任意协议交给系统上注册的处理器
 * —— 那等于让一段构建日志拥有了拉起任意本地程序的能力。
 *
 * 注意匹配的是**已转义**的文本：那里出现的 `&` 一定是某个实体的一部分，
 * 真 `&` 早已变成 `&amp;`。所以这里只放行 `&amp;`，其余 `&` 一律截断 ——
 * 否则一句被转义的 `<a href="http://evil/">` 会让 URL 一路吃掉后面整个
 * `&quot;&gt;…` 尾巴。
 *
 * 排除中日韩文字与全角标点，是因为地址后面**不加空格**直接接中文的写法很常见
 * （`请访问 http://localhost:5173/查看详情`）。那些字不是 ASCII 标点，行尾裁剪
 * 那套规则够不着，不在这里截断就会把半句话带进地址里。真实 dev server 的地址
 * 全是 ASCII，所以这个取舍不会误伤。
 */
const URL_RE =
  /https?:\/\/(?:&amp;|[^\s<>"'`&\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])+/gi

/** 便宜的先验：绝大多数日志行根本没有链接，不必为它们做切片 */
const HAS_URL = /https?:\/\//i

/** 行尾标点不属于 URL（`➜  Local: http://localhost:5173/` 后面常跟句号或括号） */
const TRAILING = /[.,;:!?)\]}>"'。，、；：！？）】」』]+$/

const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/** 转义后的文本里 `&` 已是 `&amp;`，还原成真正的 URL 才拿得去打开 */
function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITY[m] ?? m)
}

function attr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 切成「标签」与「文本」交替的片段序列 */
const TAG_OR_TEXT = /<[^>]*>|[^<]+/g

/**
 * 把一行 HTML 里的 URL 变成可点的元素。
 *
 * 在 ansi_up 转义**之后**按片段替换，安全边界因此没有被移动：日志内容早在
 * `escape_html` 那一步就已经是纯文本，而这里又绝不碰任何 `<...>` 片段。
 * 反过来的两种写法都不行 —— 先替换再转义会把自己生成的标签也转义掉；对整段
 * HTML 直接跑正则则可能命中标签内部的属性。
 *
 * 产出 `<a data-url>` 而**不是** `<a href>`：渲染进程里一个真的 href 被点中
 * 会把整个应用窗口导航到那个地址，界面上就再也回不来了。点击统一由 LogPanel
 * 委派处理，经 IPC 交给系统浏览器。
 */
function linkify(html: string): string {
  return html.replace(TAG_OR_TEXT, (seg) => {
    if (seg.charCodeAt(0) === 60) return seg /* '<' */
    return seg.replace(URL_RE, (hit) => {
      const url = hit.replace(TRAILING, '')
      const tail = hit.slice(url.length)
      const href = attr(decode(url))
      return `<a class="log-link" data-url="${href}" title="在浏览器里打开：${href}">${url}</a>${tail}`
    })
  })
}

export function toHtml(text: string): string {
  // 先摘掉 OSC：ansi_up 不认它，会把这些控制序列原样吐进 DOM。CSI 不能碰 ——
  // 那是它上色的输入，提前剥掉整片日志就全成白板了。
  const clean = stripOsc(text)
  let html: string
  try {
    html = ansi.ansi_to_html(clean)
  } catch {
    // 单行渲染失败不能拖垮整个日志面板
    html = clean.replace(/[&<>]/g, (c) => FALLBACK[c] ?? c)
  }
  return HAS_URL.test(clean) ? linkify(html) : html
}

/**
 * 这一行里最后一个 http(s) 链接。
 *
 * 供日志面板头部的「打开链接」入口、以及卡片上的「链接」下拉用 —— 那些地方要的是
 * URL 本身，而不是渲染好的 HTML。Vite 把地址打在第一屏，之后就被后续输出顶上去
 * 了，靠肉眼往回翻很不现实。
 *
 * 先 `stripAnsi` 再找：这个函数拿到的是**原始文本**（带控制序列），不像 linkify
 * 那样已经站在 ansi_up 转好的 HTML 上。少了这一步，带色的那一行会把尾部还原序列
 * 吃进地址里 —— 界面看着正常，点开却打不开。
 */
export function lastUrl(text: string): string | null {
  const hits = stripAnsi(text).match(URL_RE)
  const last = hits?.[hits.length - 1]
  return last ? last.replace(TRAILING, '') : null
}
