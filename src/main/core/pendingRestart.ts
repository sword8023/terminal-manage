import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 升级留在磁盘上的一次性意图：装完重启之后，要不要把「已标记」的命令一并拉起来。
 *
 * 为什么不塞进 settings（见 docs/升级模块方案.md §6.6）：
 *  - 它是**一次性意图**，不是用户偏好。留在 settings 里，下次启动还会被读到
 *  - 用户在确认框里勾了又取消、或者安装根本没成功时，这个意图必须自然作废
 *  - 放在 userData 下，天然跟随 `TM_USER_DATA` 隔离，端到端探针不会污染真实配置
 */
export interface PendingRestart {
  restartMarked: boolean
  /** 发起升级时的版本，只用于日志排查 */
  fromVersion: string
  /** 写入时刻（毫秒） */
  at: number
}

export function pendingRestartPath(userData: string): string {
  return join(userData, 'pending-restart.json')
}

export async function writePendingRestart(file: string, payload: PendingRestart): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(payload), 'utf8')
}

/**
 * 读取并**立即删除**。
 *
 * 读取即消费：这个文件描述的是「刚刚那次升级」，看过一次就没有意义了。留着的坏处是
 * 下次启动（甚至下个月）还会照着它把命令拉起来 —— 那时的用户早已不记得自己勾过什么。
 * 因此无论内容是否能解析，都在返回前删掉。
 *
 * 单独放一个 Electron-free 的模块，是为了让这段「读一份可能有半个 JSON 的文件」的
 * 逻辑能被裸 node 直接单测。
 */
export async function consumePendingRestart(file: string): Promise<PendingRestart | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // 不存在是常态：绝大多数启动都没有升级过
    return null
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }

  try {
    const raw = JSON.parse(text) as Partial<PendingRestart> | null
    if (typeof raw?.restartMarked !== 'boolean') return null
    return {
      restartMarked: raw.restartMarked,
      fromVersion: typeof raw.fromVersion === 'string' ? raw.fromVersion : '',
      at: typeof raw.at === 'number' ? raw.at : 0,
    }
  } catch {
    // 写一半就被 app.exit(0) 打断的情形：当作没有升级过，别把命令拉起来
    return null
  }
}
