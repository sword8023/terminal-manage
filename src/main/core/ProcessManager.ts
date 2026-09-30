import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from './killTree'
import { LineBuffer } from './LineBuffer'
import { LogBatcher } from './LogBatcher'
import { isPortInUse } from './PortScanner'
import { META_PREFIX } from '@shared/log'
import type {
  AppSettings,
  ExitInfo,
  LineEvent,
  ProcessStatus,
  RuntimeState,
  SpawnSpec,
} from '@shared/types'

/**
 * 从日志中识别「服务已就绪」的信号，并顺带解析出实际端口。
 * Vite / Next / vue-cli 打印的地址形态基本都落在 localhost|127.0.0.1|0.0.0.0 上。
 */
const READY_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i

/** 就绪信号等待上限：超时后不再纠结，直接视为 running，避免界面永远转圈 */
const READY_TIMEOUT_MS = 10_000

export interface ProcessManagerHooks {
  onStatus(state: RuntimeState): void
  onLog(nodeId: string, events: LineEvent[]): void
  onExit(info: ExitInfo): void
}

interface Entry {
  state: RuntimeState
  child: ChildProcess | null
  buffer: LineBuffer
  batcher: LogBatcher
  readyTimer: NodeJS.Timeout | null
  /**
   * 世代号：每次 spawn 自增。
   *
   * 这是本模块最重要的一个防护。停止再启动时，旧进程的 exit 事件可能在
   * 新进程已经起来之后才送达，如果不做世代比对，旧回调会把刚启动的命令
   * 直接标成「已退出」。
   */
  generation: number
  stoppedByUser: boolean
  /** exit 事件只处理一次（killTree 超时兜底可能和事件回调撞车） */
  exited: boolean
  /** 等待退出完成的 waiter，供 restart 串行化 */
  exitWaiters: Array<() => void>
}

/**
 * 进程管理器。
 *
 * 它**不认识分组树** —— 入口只接受已经解析好的 `SpawnSpec`（含 cwd 和命令行）。
 * 「cwd 从哪个祖先分组继承」这类业务判断留在 ipc 层，于是进程管理可以独立
 * 于数据模型演进，也能被集成测试直接驱动而不必先造一棵树。
 */
export class ProcessManager {
  private readonly entries = new Map<string, Entry>()
  private settings: AppSettings
  private readonly hooks: ProcessManagerHooks

  constructor(settings: AppSettings, hooks: ProcessManagerHooks) {
    this.settings = settings
    this.hooks = hooks
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings
  }

  /** 全部运行时状态，供渲染进程首次挂载时同步 */
  snapshot(): RuntimeState[] {
    return [...this.entries.values()].map((e) => ({ ...e.state }))
  }

  get(nodeId: string): RuntimeState | undefined {
    const entry = this.entries.get(nodeId)
    return entry ? { ...entry.state } : undefined
  }

  /** 是否处于「占用着资源」的状态 */
  isActive(nodeId: string): boolean {
    const status = this.entries.get(nodeId)?.state.status
    return status === 'starting' || status === 'running' || status === 'stopping'
  }

  /** 主进程侧保留的日志尾巴，供渲染进程重载后重放历史 */
  retainedLog(nodeId: string): string[] {
    return this.entries.get(nodeId)?.buffer.snapshot() ?? []
  }

  clearLog(nodeId: string): void {
    this.entries.get(nodeId)?.buffer.clear()
  }

  activeIds(): string[] {
    return [...this.entries.values()]
      .filter((e) => this.isActive(e.state.nodeId))
      .map((e) => e.state.nodeId)
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(spec: SpawnSpec): Promise<RuntimeState> {
    const entry = this.ensureEntry(spec.id)

    // 幂等保护：重复点击启动若直接 spawn，会瞬间起两份 dev server 抢同一端口
    if (this.isActive(spec.id)) {
      this.logDirect(entry, '该命令已在运行，忽略本次启动请求')
      entry.batcher.flush()
      return { ...entry.state }
    }

    const cwd = spec.cwd

    // 端口预检：**只警告不拦截**。Vite 遇到端口占用会自动 +1，
    // 强行阻止反而挡住了「我就是想再开一个」的正当用法。
    if (spec.expectedPort !== undefined && (await isPortInUse(spec.expectedPort))) {
      this.logDirect(
        entry,
        `⚠ 端口 ${spec.expectedPort} 已被占用，` +
          'dev server 可能自动改用其它端口，请留意下方日志中的实际地址',
      )
    }

    const generation = entry.generation + 1
    entry.generation = generation
    entry.stoppedByUser = false
    entry.exited = false
    entry.buffer.clear()

    const isPwsh = spec.shell === 'powershell'
    const shellExe = isPwsh ? 'powershell.exe' : 'cmd.exe'
    // chcp 65001 把控制台代码页切到 UTF-8，否则 vite 输出的中文会是乱码。
    // 用 spawn(..., [cmd]) 而不是 shell:true —— 后者会引入一层额外的
    // cmd 解析，命令里带空格或引号时极易出错。
    const full = isPwsh ? `chcp 65001 > $null; ${spec.command}` : `chcp 65001 >nul && ${spec.command}`
    const args = isPwsh ? ['-NoLogo', '-NoProfile', '-Command', full] : ['/d', '/c', full]

    const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) }
    if (this.settings.forceColor) {
      // 由本应用接管颜色：清掉外部 NO_COLOR，再注入 FORCE_COLOR。
      // 不做这一步的话，vite/chalk 检测到 stdout 不是 TTY 会主动关闭颜色，
      // 日志区就只剩黑白。
      delete env.NO_COLOR
      env.FORCE_COLOR = '1'
    } else {
      delete env.FORCE_COLOR
    }

    let child: ChildProcess
    try {
      child = spawn(shellExe, args, {
        cwd,
        env,
        windowsHide: true,
        // stdin 直接丢弃：本工具不接受交互输入。
        // 若给 pipe 又不写入，某些命令会一直等输入而假死。
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.setStatus(entry, 'error', { lastError: (err as Error).message })
      this.logDirect(entry, `✖ 启动失败：${(err as Error).message}`)
      entry.batcher.flush()
      return { ...entry.state }
    }

    entry.child = child
    entry.state = {
      nodeId: spec.id,
      status: 'starting',
      pid: child.pid,
      exitCode: undefined,
      signal: undefined,
      startedAt: Date.now(),
      detectedPort: undefined,
      lastError: undefined,
      stoppedByUser: false,
    }
    this.hooks.onStatus({ ...entry.state })

    // 展示名与实际命令不同时才都打出来，否则这行会自我重复
    const head =
      spec.label && spec.label !== spec.command
        ? `${spec.label}  ▸  ${spec.command}`
        : spec.command
    this.logDirect(
      entry,
      `▶ ${head}  (pid ${child.pid ?? '?'}, cwd ${cwd})`,
    )

    const onData = (chunk: Buffer): void => {
      if (entry.generation !== generation) return
      const events = entry.buffer.push(chunk.toString('utf-8'))
      if (events.length === 0) return
      entry.batcher.push(events)
      this.detectReady(entry, events)
    }

    child.stdout?.on('data', onData)
    // stdout 与 stderr 合并到同一条管道：用户关心的是「按时间顺序发生了什么」，
    // 而不是「这句话写到了哪个 fd」。分两条会导致顺序错乱。
    child.stderr?.on('data', onData)

    child.on('error', (err) => {
      if (entry.generation !== generation || entry.exited) return
      entry.exited = true
      this.clearReadyTimer(entry)
      this.setStatus(entry, 'error', { lastError: err.message, pid: undefined })
      this.logDirect(entry, `✖ 进程错误：${err.message}`)
      entry.batcher.flush()
      this.releaseWaiters(entry)
    })

    child.on('exit', (code, signal) => {
      if (entry.generation !== generation) return
      this.finishExit(entry, code, signal ?? null)
    })

    // 就绪降级：10 秒内没等到地址信号也认为已经起来了
    entry.readyTimer = setTimeout(() => {
      entry.readyTimer = null
      if (entry.generation !== generation) return
      if (entry.state.status === 'starting') {
        this.setStatus(entry, 'running', {})
      }
    }, READY_TIMEOUT_MS)

    return { ...entry.state }
  }

  async stop(nodeId: string): Promise<void> {
    const entry = this.entries.get(nodeId)
    const child = entry?.child
    if (!entry || !child) return

    entry.stoppedByUser = true
    this.clearReadyTimer(entry)
    this.setStatus(entry, 'stopping', {})
    this.logDirect(entry, `⏹ 正在终止进程树（pid ${child.pid ?? '?'}）…`)
    entry.batcher.flush()

    // 关键：必须杀整棵树。
    // `npm run dev` 的真实链路是 cmd.exe → node(npm) → node(vite) → esbuild.exe，
    // child.kill() 只终止第一层，vite 会继续占着端口变成僵尸进程。
    // taskkill /T 递归终止整棵树的机制已在 M0 spike 中实测验证。
    await killTree(child.pid)
    await this.waitForExit(entry)

    // 兜底：killTree 超时且 exit 事件永不到达时手动收尾，
    // 否则界面会永远卡在「停止中」。
    if (!entry.exited) this.finishExit(entry, null, null)
  }

  async restart(spec: SpawnSpec): Promise<RuntimeState> {
    const entry = this.ensureEntry(spec.id)
    await this.stop(spec.id)
    // stop 内部已等到 exit，这里再做一次兜底，确保 start 不会被幂等检查挡住
    await this.waitForExit(entry)
    return this.start(spec)
  }

  /** 依次停止全部运行中的命令 */
  async stopAll(): Promise<void> {
    await Promise.all(this.activeIds().map((id) => this.stop(id)))
  }

  /**
   * 依次启动多条命令，之间留一段间隔。
   * 同时 spawn 五个 vite 会瞬间打满 CPU，反而让每个都更慢。
   */
  async startAll(specs: readonly SpawnSpec[]): Promise<RuntimeState[]> {
    for (const spec of specs) {
      if (this.isActive(spec.id)) continue
      try {
        await this.start(spec)
      } catch (err) {
        console.error(`[process] 启动 ${spec.label} 失败：`, err)
      }
      const gap = this.settings.launchDelayMs
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
    }
    return this.snapshot()
  }

  /** 退出应用时调用：同步尽量快，但必须确保不留孤儿进程 */
  async dispose(): Promise<void> {
    const ids = this.activeIds()
    await Promise.all(
      ids.map(async (id) => {
        const entry = this.entries.get(id)
        if (!entry) return
        entry.stoppedByUser = true
        this.clearReadyTimer(entry)
        entry.batcher.dispose()
        await killTree(entry.child?.pid)
      }),
    )
  }

  /** 删除命令前清理其运行时记录 */
  async forget(nodeId: string): Promise<void> {
    await this.stop(nodeId)
    this.entries.get(nodeId)?.batcher.dispose()
    this.entries.delete(nodeId)
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private ensureEntry(nodeId: string): Entry {
    let entry = this.entries.get(nodeId)
    if (!entry) {
      entry = {
        state: { nodeId, status: 'idle' },
        child: null,
        buffer: new LineBuffer(),
        batcher: new LogBatcher(nodeId, (batch) => {
          this.hooks.onLog(nodeId, batch.events)
        }),
        readyTimer: null,
        generation: 0,
        stoppedByUser: false,
        exited: false,
        exitWaiters: [],
      }
      this.entries.set(nodeId, entry)
    }
    return entry
  }

  private setStatus(entry: Entry, status: ProcessStatus, patch: Partial<RuntimeState>): void {
    entry.state = { ...entry.state, ...patch, status }
    this.hooks.onStatus({ ...entry.state })
  }

  /**
   * 插一行「工具自己的」提示（启动横幅、端口警告、退出提示……）。
   *
   * 前缀由这里统一加、不散落在调用点：渲染层正是按 `META_PREFIX` 把工具自己的行
   * 和被监控进程的真实输出分开的 —— 横幅会把命令行原样回显，命令行文本里自带的
   * 地址（`curl http://内网/health`）不能算成「这条命令暴露的链接」。
   * 判据的完整说明见 src/shared/log.ts。
   */
  private logDirect(entry: Entry, text: string): void {
    entry.batcher.push([{ type: 'append', text: `${META_PREFIX} ${text}` }])
  }

  private detectReady(entry: Entry, events: readonly LineEvent[]): void {
    if (entry.state.status !== 'starting') return
    for (const event of events) {
      const m = READY_RE.exec(event.text)
      if (!m) continue

      const port = Number(m[1])
      this.clearReadyTimer(entry)
      this.setStatus(entry, 'running', {
        detectedPort: port >= 1 && port <= 65535 ? port : undefined,
      })
      return
    }
  }

  private clearReadyTimer(entry: Entry): void {
    if (entry.readyTimer !== null) {
      clearTimeout(entry.readyTimer)
      entry.readyTimer = null
    }
  }

  /** exit 收尾，幂等 */
  private finishExit(entry: Entry, code: number | null, signal: string | null): void {
    if (entry.exited) return
    entry.exited = true

    this.clearReadyTimer(entry)

    // 把缓冲里最后一段没有换行的内容吐出来，
    // 否则进程崩溃时最关键的那行报错（通常不以 \n 结尾）会凭空消失
    const tail = entry.buffer.flush()
    if (tail.length) entry.batcher.push(tail)

    const stoppedByUser = entry.stoppedByUser
    const exitCode = typeof code === 'number' ? code : null

    // 走 logDirect 而不是直接往 batcher 里塞：工具自己的行必须带上 META_PREFIX，
    // 渲染层才知道这不是被监控进程的输出（判据见 src/shared/log.ts）
    this.logDirect(
      entry,
      `■ 进程已退出` +
        `（退出码 ${exitCode ?? 'null'}${signal ? `，信号 ${signal}` : ''}）` +
        (stoppedByUser ? '' : ' —— 非用户主动停止，请检查上方日志'),
    )

    entry.child = null
    this.setStatus(entry, 'exited', {
      exitCode,
      signal,
      pid: undefined,
      stoppedByUser,
      lastError:
        !stoppedByUser && (exitCode === null || exitCode !== 0)
          ? `进程异常退出（退出码 ${exitCode ?? signal ?? '未知'}）`
          : undefined,
    })

    entry.batcher.flush()
    this.releaseWaiters(entry)
    this.hooks.onExit({ nodeId: entry.state.nodeId, code: exitCode, signal, stoppedByUser })
  }

  private waitForExit(entry: Entry, timeoutMs = 9000): Promise<void> {
    if (entry.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const i = entry.exitWaiters.indexOf(waiter)
        if (i >= 0) entry.exitWaiters.splice(i, 1)
        resolve()
      }, timeoutMs)
      entry.exitWaiters.push(waiter)
    })
  }

  private releaseWaiters(entry: Entry): void {
    for (const waiter of entry.exitWaiters.splice(0)) waiter()
  }
}
