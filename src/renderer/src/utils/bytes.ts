/**
 * 字节数的显示格式化。
 *
 * 单独放一个文件是为了能被单测覆盖：进度、包大小、下载速率三处都要用它，而把
 * `111457653` 这种数字直接摆到界面上等于没说。用 1024 进制而不是 1000：用户会
 * 对着资源管理器核对，那边就是 1024 进制，两边不一致看起来像算错了（单位写
 * KB/MB 而不用 KiB/MiB，是这个界面里没人会误解的折中）。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${Math.round(value)} B`

  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024
    unit += 1
  }

  // 超过 100 就取整：再带一位小数，数字会随着下载过程不停改变宽度（106.3 → 99.8 → 98.4），
  // 在一秒钟刷新十次的进度旁边非常刺眼
  const text =
    scaled >= 100 || Number.isInteger(Number(scaled.toFixed(1)))
      ? String(Math.round(scaled))
      : scaled.toFixed(1)
  return `${text} ${UNITS[unit]}`
}
