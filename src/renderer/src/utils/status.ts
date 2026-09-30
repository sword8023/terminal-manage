import type { ProcessStatus } from '@shared/types'

export const STATUS_TEXT: Record<ProcessStatus, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  exited: '已退出',
  error: '启动失败',
}

/** 「占用中」的两种状态：都意味着不能再次启动，但可以停止 */
export function isUp(status: ProcessStatus): boolean {
  return status === 'running' || status === 'starting'
}
