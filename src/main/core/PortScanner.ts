import { createConnection } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PortCheckResult } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * 探测端口是否已被监听。
 *
 * 用「发起 TCP 连接」而不是「尝试 bind」来判断：
 * bind 探测需要先占用再释放端口，存在与正在启动的 dev server 抢端口的竞态。
 * 连接探测没有副作用。
 */
export function isPortInUse(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ port, host })

    const done = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 从 netstat 输出中查出监听指定端口的 PID */
export async function findPidByPort(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })

    for (const line of stdout.split(/\r?\n/)) {
      // 只认 LISTENING，否则「已建立连接」的对端端口也会被算作占用
      if (!line.includes('LISTENING')) continue

      const cols = line.trim().split(/\s+/)
      if (cols.length < 5) continue

      // 形如 127.0.0.1:5173 或 [::]:5173
      const local = cols[1]
      const localPort = Number(local.slice(local.lastIndexOf(':') + 1))
      const pid = Number(cols[4])

      if (localPort === port && Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    // netstat 不可用（极少见）时静默降级，不影响主流程
  }
  return undefined
}

/** 由 PID 反查进程名，用于提示「5173 被 node.exe 占用」 */
export async function getProcessName(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
    )
    const m = stdout.match(/^"([^"]+)"/)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** 启动前的端口冲突预检 */
export async function checkPort(port: number): Promise<PortCheckResult> {
  const inUse = await isPortInUse(port)
  if (!inUse) return { inUse: false }

  const pid = await findPidByPort(port)
  const processName = pid !== undefined ? await getProcessName(pid) : undefined
  return { inUse: true, pid, processName }
}
