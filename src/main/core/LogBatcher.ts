import type { LineEvent, LogBatch } from '@shared/types'

/**
 * 日志批量发送器。
 *
 * 逐行发送 IPC 在 vite 冷启动时会瞬间产生上千次跨进程调用，直接把渲染进程压垮。
 * 这里按约一帧（16ms）的窗口聚合成批，并设容量上限：
 * 单批累积到 maxEvents 立刻 flush，避免一次发送超大 payload 造成长任务卡顿。
 */
export class LogBatcher {
  private buffer: LineEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private seq = 0

  constructor(
    private readonly id: string,
    private readonly flushFn: (batch: LogBatch) => void,
    /** 聚合窗口；约等于一帧 */
    private readonly intervalMs = 16,
    /** 单批事件数上限，超过则立即发送 */
    private readonly maxEvents = 500,
  ) {}

  push(events: readonly LineEvent[]): void {
    if (events.length === 0) return
    // 展开拷贝，避免调用方后续复用同一个数组
    for (const e of events) this.buffer.push(e)

    if (this.buffer.length >= this.maxEvents) {
      this.flush()
      return
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.intervalMs)
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return

    const events = this.buffer
    this.buffer = []
    this.seq += 1
    this.flushFn({ id: `${this.id}:${this.seq}`, events })
  }

  /** 进程退出或窗口关闭时调用，确保尾部日志不丢 */
  dispose(): void {
    this.flush()
  }
}
