import type { LineEvent } from '@shared/types'

/**
 * 把原始输出流归一化为「行事件」。
 *
 * 需要处理四种情况：
 *   1. `\n` 换行         → append 新行
 *   2. `\r\n`（Windows） → 同上，但要先剥掉行尾的 `\r`
 *   3. `\r` 覆写当前行   → replace 最后一行（构建进度条就是这么输出的）
 *   4. `\r` 落在 chunk 末尾 → **必须延迟判定**，因为它可能是 `\r\n` 的前半
 *
 * 第 4 种情况是最容易写错的地方：若 chunk 恰好切在 `\r` 和 `\n` 之间
 * （`"abc\r"` + `"\ndef"`），立即处理会把 `\r` 当成覆写，导致 `"abc"` 被误清空。
 * 因此本实现把行尾悬空的 `\r` 暂存到 `carry`，等下一块到了再判定。
 *
 * 归一化放在**主进程**执行，这样环形缓冲里存的永远是「定型」的行；
 * 渲染进程刷新后重放历史时不会重现 `\r` 混乱。
 */
export class LineBuffer {
  /** 已提交的完整行（仅为「渲染进程重载后重放」而保留，因此有上限） */
  private lines: string[] = []
  /** 当前未换行的活动行 */
  private current = ''
  /** 跨 chunk 悬空的内容（目前只可能是行尾的一个 `\r`） */
  private carry = ''

  /**
   * 保留的最大行数。
   *
   * 主进程**不能**无限缓存日志：dev server 连跑几个小时会产生几十万行，
   * 无上限即内存泄漏。日志的完整副本由渲染进程持有，
   * 这里只是为了「界面重载后能补回历史」而留一个尾巴。
   *
   * ⚠️ 这里刻意写成「显式字段 + 构造函数里赋值」，而不是
   * `constructor(private readonly capacity = 1000) {}`。
   * 原因是 Node 的 **strip-only 类型擦除模式不支持 parameter property** ——
   * 那种写法需要*生成*代码（把参数赋给同名属性），而 strip-only 只做删除，
   * 因此直接抛：
   *   SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
   *   TypeScript parameter property is not supported in strip-only mode
   *
   * 本项目用 `node --test src/**\/*.ts` 直接跑单元测试（零构建步骤），
   * 这个便利性值得多写两行。
   */
  private readonly capacity: number

  constructor(capacity = 1000) {
    this.capacity = capacity
  }

  /** 已提交的完整行（只读快照） */
  get committed(): readonly string[] {
    return this.lines
  }

  /** 已提交行的副本，用于渲染进程重载后重放历史 */
  snapshot(): string[] {
    return this.lines.slice()
  }

  /** 当前未换行的活动行 */
  get active(): string {
    return this.current
  }

  push(chunk: string): LineEvent[] {
    if (!chunk) return []

    let data = this.carry + chunk
    this.carry = ''

    // 行尾悬空的 \r 可能是 \r\n 的前半，推迟到下一块再判定
    if (data.endsWith('\r')) {
      this.carry = '\r'
      data = data.slice(0, -1)
    }
    if (!data) return []

    const events: LineEvent[] = []
    const parts = data.split('\n')

    for (let i = 0; i < parts.length; i++) {
      let seg = parts[i]
      const terminated = i < parts.length - 1

      // Windows 的 \r\n：先剥掉行尾的 \r，避免被误判成「覆写」
      if (terminated && seg.endsWith('\r')) {
        seg = seg.slice(0, -1)
      }

      const cr = seg.lastIndexOf('\r')
      if (cr >= 0) {
        // \r 之后的内容覆盖当前行
        this.current = seg.slice(cr + 1)
        if (!terminated) {
          events.push({ type: 'replace', text: this.current })
          continue
        }
      } else {
        this.current += seg
      }

      if (terminated) {
        events.push({ type: 'append', text: this.current })
        this.lines.push(this.current)
        this.current = ''
        this.trim()
      }
    }

    return events
  }

  /**
   * 流结束时调用：把尚未换行的残留内容提交掉。
   * 否则进程最后一行若没有以 `\n` 结尾就会丢失。
   */
  flush(): LineEvent[] {
    const events: LineEvent[] = []

    if (this.carry) {
      // 悬空的 \r：按「覆写为空行」处理
      this.carry = ''
      this.current = ''
      events.push({ type: 'replace', text: '' })
    }

    if (this.current) {
      events.push({ type: 'append', text: this.current })
      this.lines.push(this.current)
      this.current = ''
    }

    return events
  }

  /**
   * 摊还 O(1) 的裁剪：只在超出 `capacity + 256` 时才批量丢弃。
   * 若每行都做一次 splice(0, 1)，高频日志下每行都要移动整个数组。
   */
  private trim(): void {
    const overflow = this.lines.length - this.capacity
    if (overflow >= 256) this.lines.splice(0, overflow)
  }

  clear(): void {
    this.lines = []
    this.current = ''
    this.carry = ''
  }
}
