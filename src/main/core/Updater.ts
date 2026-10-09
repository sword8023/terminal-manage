import { app, net } from 'electron'
import { join } from 'node:path'
import type { UpdateState } from '@shared/types'
import { DownloadError, createProgressThrottle, downloadToFile, type FetchLike } from './downloader'
import { installerArgsFor, launchInstaller } from './installer'
import { writePendingRestart } from './pendingRestart'
import { assetFileName, assertAllowedUrl, parseFeed, withCacheBuster } from './updateFeed'

/**
 * 安装这一步的外部副作用，全部由主进程注入。
 *
 * 不在这里直接 import ProcessManager / ConfigStore：状态机一旦认识它们，就没法再
 * 单独推演「安装时序」本身；而这一步真正需要的只有四件事 —— 停子进程、落盘设置、
 * 起安装器、退出。
 */
export interface InstallHooks {
  /**
   * 安装前把在跑的子进程全部收掉。
   *
   * 必须先停：安装器要覆写安装目录里的文件，任何还在运行的同名 exe 都会让它失败，
   * 而且是那种「点了升级，安装器一闪而过、版本号没变」的哑失败。
   */
  dispose?: () => Promise<void>
  /**
   * 落盘待写的设置（`store.flush()`）。
   *
   * 退出走的是 `app.exit(0)`，它会**跳过** before-quit 里的收尾；设置若还压在
   * 防抖里就永远写不进去了。
   */
  flush?: () => Promise<void>
  /** 起安装器。默认 detached spawn；注入是为了端到端夹具能换成假安装器 */
  launch?: (filePath: string, args: readonly string[]) => void
  /** 真正退出本进程。默认 `app.exit(0)`，见下面 install() 里的那段注释 */
  exit?: () => void
}

/**
 * 构造时把默认值填好之后的形态。
 *
 * `launch` / `exit` 一定有值（构造函数给了默认），但 `InstallHooks` 里它们是可选的 ——
 * 直接拿那个类型存字段，安装时就得写 `this.hooks.launch!()`，等于用断言掩盖
 * 「其实已经保证有值」这件事。分成两个类型，编译器就能替我们盯着。
 */
type ResolvedInstallHooks = InstallHooks & {
  launch: (filePath: string, args: readonly string[]) => void
  exit: () => void
}

export interface UpdaterOptions {
  /** app.getVersion()。注入而不是内部读 —— 状态机因此不依赖 Electron */
  currentVersion: string
  /**
   * 取当前生效的更新源。
   *
   * 传函数而不是字符串：用户随时可能在设置里改源，若在构造时定成一个值，
   * 就会出现「改了设置、下次检查还在用老源」—— 这种故障完全没有症状。
   */
  getFeedUrl: () => string
  /**
   * 诊断出口。
   *
   * 升级功能的失败模式几乎全是静默的（用户看到的是「没反应」），所以每一步都
   * 要留下痕迹。接到 `TM_DEBUG=1` 的 debug.log 上（见 src/main/index.ts:27-35）。
   */
  log?: (message: string) => void
  /** 状态变化；主进程据此广播 EVT_UPDATE_STATUS */
  onState?: (state: UpdateState) => void
  /**
   * 安装包落盘目录，一般是 `<userData>/updates`。
   *
   * 放 userData 而不是 temp：它自动跟随 `TM_USER_DATA` 隔离（README.md:78），
   * 端到端探针能干净地测；「打开所在文件夹」这个兜底入口也需要它稳定存在。
   */
  downloadDir?: string
  /**
   * 网络实现。生产环境就是 Electron 的 `net.fetch`。
   *
   * 注入是为了让下载逻辑能被单测直接喂字节，不必把 Electron 拉进测试进程。
   */
  fetchImpl?: FetchLike
  /** 单次网络请求的超时（毫秒） */
  timeoutMs?: number
  /** process.platform，注入便于测试 */
  platform?: string
  /** 安装阶段的外部副作用，见 InstallHooks */
  hooks?: InstallHooks
  /**
   * 一次性意图文件（`<userData>/pending-restart.json`）的路径。
   *
   * 不传就不写：安装本身与这个文件无关，写失败也绝不能挡住升级。
   */
  pendingRestartFile?: string
  /**
   * 安装目录，即安装包要装到哪里（打包态是 exe 所在目录）。
   *
   * 必须显式传给安装器（`/D=`）：NSIS 的静默安装**不会**自己找到「当前这个应用装在哪」，
   * 不给 /D 时它安静地什么都不做（详见 installer.ts）。
   */
  installDir?: string
  /**
   * 安装器参数，覆盖默认值。默认由 `installerArgsFor(installDir)` 拼出来
   * （`['/S', '--force-run', '/D=<安装目录>']`，理由见 installer.ts）。
   *
   * 留这个口子是给「不想要 --force-run 拉起的隔离验收」用的：安装器拉起的新实例不继承
   * 探针的环境变量（实测），会打到真实 userData 上去。
   */
  installerArgs?: readonly string[]
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * 更新流程的状态机（M1：检测；M2：下载；M3：静默安装并退出）。
 *
 * 状态只此一份，渲染层纯展示 —— 和 ProcessManager 一样的结构。两侧各存一份的话，
 * 「界面说正在下载、主进程其实早失败了」这种漂移必然发生，且无从定位。
 *
 * 安装是这条链上唯一**不可回退**的一步：它会停掉所有命令、替换掉自己正在运行的程序，
 * 所以这里只负责把时序钉死，真正的决定（要不要重启后拉起命令）留给界面上的用户。
 */
export class Updater {
  private readonly currentVersion: string
  private readonly getFeedUrl: () => string
  private readonly log: ((message: string) => void) | undefined
  private readonly onState: ((state: UpdateState) => void) | undefined
  private readonly downloadDir: string | undefined
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly hooks: ResolvedInstallHooks
  private readonly pendingRestartFile: string | undefined
  private readonly installerArgs: readonly string[]
  private current: UpdateState
  /** 正在进行的下载；「取消」就是 abort 它 */
  private abortController: AbortController | null = null

  constructor(options: UpdaterOptions) {
    this.currentVersion = options.currentVersion
    this.getFeedUrl = options.getFeedUrl
    this.log = options.log
    this.onState = options.onState
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.downloadDir = options.downloadDir
    this.pendingRestartFile = options.pendingRestartFile
    this.installerArgs = options.installerArgs ?? installerArgsFor(options.installDir)
    this.hooks = {
      dispose: options.hooks?.dispose,
      flush: options.hooks?.flush,
      launch: options.hooks?.launch ?? launchInstaller,
      exit: options.hooks?.exit ?? (() => app.exit(0)),
    }
    // 包一层箭头函数而不是直接传 net.fetch：this 绑定明确，类型也收敛到
    // 本模块定义的最小接口（只用 ok / status / headers / body 四项）
    this.fetchImpl = options.fetchImpl ?? ((url, init) => net.fetch(url, init))
    this.current = {
      // 本工具的更新链路只覆盖 win-x64：打包只出 Windows 安装包，
      // 非 Windows 上连检查都没有意义
      phase: (options.platform ?? process.platform) === 'win32' ? 'idle' : 'unsupported',
      current: options.currentVersion,
    }
  }

  get state(): UpdateState {
    return this.current
  }

  /**
   * 检查更新。
   *
   * `silent` 决定失败时留不留痕迹，它对应两种完全不同的发起者：
   *  - **自动检查**（silent）：用户没要求过这次请求。离线、源在维护、公司网拦掉
   *    都是常态，此时在界面上留一条红字只会让人以为应用坏了 —— 所以状态原样退回，
   *    只写诊断日志。
   *  - **手动检查**（默认）：用户明确点了按钮，必须给一个明确答复，包括失败原因。
   */
  async check(options: { silent?: boolean } = {}): Promise<UpdateState> {
    if (this.current.phase === 'unsupported') return this.current
    // 已经在检查中就不重入：自动检查与手动点击撞上时，第二个请求的结果
    // 会覆盖第一个，而静默分支的「恢复原状态」可能把手动那次的结果抹掉。
    if (this.current.phase === 'checking') return this.current
    // 正在下载时不许检查：check() 会把状态改成 checking → available 并清掉 progress /
    // filePath，而那条下载还在写 .part —— 界面上的进度条凭空消失，用户再点一次「下载」
    // 就会起第二条连接写同一个文件（真机验收时就撞上过：启动 10 秒后的自动检查正好落在
    // 下载中间）。要停下载只能走「取消下载」。
    if (this.abortController) {
      this.log?.('正在下载，跳过这次检查')
      return this.current
    }

    const before = this.current
    const feedUrl = this.getFeedUrl().trim()
    if (!feedUrl) {
      // 还没部署更新源。自动检查不该为此报警，手动点的时候必须说清楚
      // 日志不带标签：格式由注入 log 的一方决定（主进程那边统一加 [update] 前缀）
      this.log?.('没有配置更新源，跳过检查')
      return options.silent ? this.current : this.set({ phase: 'error', error: '还没有配置更新源' })
    }

    this.set({
      phase: 'checking',
      info: undefined,
      progress: undefined,
      bytesPerSecond: undefined,
      filePath: undefined,
      error: undefined,
    })

    try {
      const raw = await this.fetchFeed(feedUrl)
      const info = parseFeed(raw, this.currentVersion)
      this.log?.(`检查完成：${info ? `有新版本 ${info.version}` : '已是最新'}`)
      return this.set({ phase: info ? 'available' : 'up-to-date', info: info ?? undefined })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log?.(`检查失败：${message}`)
      if (options.silent) {
        return this.set({
          ...before,
          phase: before.phase === 'checking' ? 'idle' : before.phase,
          error: undefined,
        })
      }
      return this.set({ phase: 'error', error: message })
    }
  }

  /**
   * 下载安装包。
   *
   * 一个刻意的取舍：**不做断点续传**。sha256 是从首字节开始流式算的，续传就必须先
   * 把已落盘的 `.part` 重读一遍喂给哈希才能接着算 —— 那一小段代码正是最容易写错、
   * 且错了以后只在「网络恰好断过一次」时才暴露的东西。重下一次 106 MB 的代价，
   * 比这种偶发损坏小得多（见 docs/升级模块方案.md §6.4）。
   */
  async download(): Promise<UpdateState> {
    // 单连接的硬不变量：abortController 非空就说明已经有一条下载在跑。这里刻意不看
    // phase —— phase 是给界面看的，可能被别的路径改过（见 check() 里的那段注释）；
    // 只认这个资源，就不会出现两条连接写同一个 .part、最后哈希必然不符的情况。
    if (this.abortController) return this.current

    const phase = this.current.phase
    // 已经在下 / 已经下好 / 正在装：都不重入。重复点「下载」不该再起一条连接
    if (
      phase === 'unsupported' ||
      phase === 'downloading' ||
      phase === 'ready' ||
      phase === 'installing'
    ) {
      return this.current
    }

    const info = this.current.info
    if (!info) return this.set({ phase: 'error', error: '还没有可下载的新版本' })
    if (!this.downloadDir) return this.set({ phase: 'error', error: '没有配置下载目录' })

    const controller = new AbortController()
    this.abortController = controller

    // 状态已经落终态之后还可能有最后一次节流回调排在队里；用一个开关挡掉，
    // 否则 ready 状态上的 progress 会被改回 0.97 这种中间值
    let settled = false
    const onProgress = createProgressThrottle((progress) => {
      // settled：已经落终态之后还排着队的最后一次回调，不许把 ready 上的 progress 改回
      // 0.97；abortController 换了人：说明这条下载已经不是当前那条，更不该改状态
      if (settled || this.abortController !== controller) return
      this.set({
        // 服务端没给 content-length 时为 null：界面显示不确定进度条
        progress: progress.total ? Math.min(1, progress.received / progress.total) : null,
        bytesPerSecond: progress.bytesPerSecond,
      })
    })

    this.set({
      phase: 'downloading',
      progress: 0,
      bytesPerSecond: undefined,
      filePath: undefined,
      error: undefined,
    })

    try {
      const result = await downloadToFile({
        url: info.asset.url,
        targetDir: join(this.downloadDir, info.version),
        fileName: assetFileName(info.asset.url, info.version),
        expectedSha256: info.asset.sha256,
        expectedSize: info.asset.size,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
        log: this.log,
        onProgress,
      })
      this.log?.(`下载完成：${result.filePath}`)
      return this.set({ phase: 'ready', progress: 1, filePath: result.filePath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 取消不是错误：退回「可以重新下载」，而不是留一条红字让用户以为坏了
      if (err instanceof DownloadError && err.cancelled) {
        this.log?.('下载已取消')
        return this.set({
          phase: 'available',
          progress: undefined,
          bytesPerSecond: undefined,
          filePath: undefined,
          error: undefined,
        })
      }
      this.log?.(`下载失败：${message}`)
      return this.set({ phase: 'error', error: message })
    } finally {
      settled = true
      this.abortController = null
    }
  }

  /**
   * 取消正在进行的下载。
   *
   * 这里**只**发中断信号，不写任何状态：下载的收尾（退回 available、清进度）统一在
   * `download()` 的 catch 里做。两边都写状态，只会得到「谁后写谁赢」的漂移。
   */
  cancelDownload(): UpdateState {
    this.abortController?.abort()
    return this.current
  }

  /**
   * 静默安装已下载的包，然后退出本进程。
   *
   * 时序刻意固定成「停子进程 → 落盘设置 → 写重启意图 → 起安装器 → 退出」，换个顺序就会坏：
   *  - `dispose` 放到起安装器之后：要覆写的 exe 还在跑，安装器一闪而过、版本号没变
   *  - 写意图放到起安装器之后：安装器可能已经把新版本拉起来了，那边读不到这个文件
   *
   * 退出走 `app.exit(0)` 而**不是** `app.quit()`：quit 会走 before-quit →
   * `shutdown()`（src/main/index.ts:335-339），那里会把子进程再 dispose 一遍，
   * 白白多出一个「安装器已经在装、旧进程还没退」的窗口。
   */
  async install(options: { restartMarked?: boolean } = {}): Promise<UpdateState> {
    if (this.current.phase === 'unsupported') return this.current
    // 已经进入安装流程就不再重入：第二次会有两个安装器抢同一个安装目录
    if (this.current.phase === 'installing') return this.current

    const filePath = this.current.filePath
    if (this.current.phase !== 'ready' || !filePath) {
      return this.set({ phase: 'error', error: '还没有下载好的安装包' })
    }

    this.set({ phase: 'installing', progress: 1, filePath, error: undefined })
    this.log?.('开始静默安装，先停止所有命令')

    try {
      await this.hooks.dispose?.()
    } catch (err) {
      // 停不干净也继续：安装器自己会处理文件占用，真装不上还有「打开所在文件夹」兜底
      this.log?.(`停止子进程时出错：${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await this.hooks.flush?.()
    } catch (err) {
      this.log?.(`落盘设置时出错：${err instanceof Error ? err.message : String(err)}`)
    }

    await this.markPendingRestart(options.restartMarked === true)

    try {
      this.hooks.launch(filePath, this.installerArgs)
      this.log?.(`安装器已启动：${filePath} ${this.installerArgs.join(' ')}`)
    } catch (err) {
      // 起不来就退回 ready：安装包还在盘上，用户可以直接再点一次
      const text = err instanceof Error ? err.message : String(err)
      this.log?.(`启动安装器失败：${text}`)
      return this.set({ phase: 'ready', error: `启动安装器失败：${text}` })
    }

    // 正常不会返回：exit 之后本进程就没了
    this.hooks.exit()
    return this.current
  }

  /**
   * 用 Electron 的 `net.fetch`，而不是 `node:https`。
   *
   * 这是整条链路上性价比最高的一个选择，三件事都是白拿的：
   *  - 自动解析并走**系统代理**（node:https 默认完全不读系统代理，企业网里直接失败）
   *  - 自动跟随 301/302（自建源挂 CDN/OSS 时跳转是常态）
   *  - 复用 Chromium 的证书配置，不用自己接 CA bundle
   */
  private async fetchFeed(feedUrl: string): Promise<unknown> {
    assertAllowedUrl(feedUrl, '更新源地址')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await net.fetch(withCacheBuster(feedUrl, Date.now()), {
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`)

      const text = await res.text()
      try {
        return JSON.parse(text) as unknown
      } catch {
        // 最常见的一种：域名下没放 latest.json，服务器回了一个 404 的 HTML 页面
        throw new Error('更新源返回的不是 JSON（检查一下地址是否指向 latest.json）')
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`请求更新源超时（${this.timeoutMs} 毫秒）`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** 改状态 + 通知。所有状态写入都必须走这里，否则界面会漏掉一次更新 */
  private set(patch: Partial<UpdateState>): UpdateState {
    this.current = { ...this.current, ...patch }
    this.onState?.(this.current)
    return this.current
  }

  /**
   * 写下「重启后要不要拉起已标记的命令」这个一次性意图。
   *
   * 写失败只记日志、绝不阻断安装：最坏的结果是升级完成、命令没被自动拉起，
   * 而用户手动点一次「启动已标记」即可 —— 反过来把升级挡下来才是真的难以补救。
   */
  private async markPendingRestart(restartMarked: boolean): Promise<void> {
    const file = this.pendingRestartFile
    if (!file) return
    try {
      await writePendingRestart(file, {
        restartMarked,
        fromVersion: this.currentVersion,
        at: Date.now(),
      })
      this.log?.(`已记录重启意图：restartMarked=${String(restartMarked)}`)
    } catch (err) {
      this.log?.(`写 pending-restart.json 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

