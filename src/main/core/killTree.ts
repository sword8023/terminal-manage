import { spawn } from 'node:child_process'

/**
 * 终止整棵进程树。
 *
 * Windows 上 `npm run dev` 的真实进程链是：
 *
 *     cmd.exe  →  node(npm)  →  node(vite)  →  esbuild.exe
 *
 * 直接调用 `child.kill()` **只终止第一层**：界面显示「已停止」，但 vite 仍在
 * 运行并占用 5173 端口。Vite 检测到端口被占会自动 +1，几轮重启后机器上就会
 * 堆积一批僵尸进程。
 *
 * 必须使用 `taskkill /T`（递归终止整棵树）。
 *
 * 此机制已在 M0 spike 中实测验证：taskkill 后端口释放、孙进程确认死亡。
 *
 * @param pid 目标进程 PID（通常是 cmd.exe 那一层）
 * @param timeoutMs 兜底超时，避免 taskkill 卡死导致调用方永久挂起
 */
export function killTree(pid: number | undefined, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
      resolve()
      return
    }

    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      // 不需要输出，用 ignore 避免额外的管道开销
      stdio: 'ignore',
    })

    const timer = setTimeout(done, timeoutMs)
    killer.on('close', done)
    killer.on('error', done)
  })
}

/**
 * 判断进程是否存活。
 *
 * `process.kill(pid, 0)` 不发送信号，只做存在性与权限检查：
 * 进程存在则返回，不存在则抛 ESRCH。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
