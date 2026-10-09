import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CH } from '@shared/channels'
import type {
  AppSettings,
  CommandCreateDTO,
  CommandNode,
  GroupCreateDTO,
  GroupFromDirDTO,
  GroupFromDirResult,
  MoveNodeDTO,
  NodeUpdateDTO,
  RescanResult,
  SpawnSpec,
} from '@shared/types'
import { defaultGroupName, readPackageInfo, scriptToCommand } from '../core/PackageReader'
import { checkPort } from '../core/PortScanner'
import type { ProcessManager } from '../core/ProcessManager'
import type { Updater } from '../core/Updater'
import { applyThemeSource, refreshWindowBackgrounds } from '../theme'
import { collectCommands, descendantIds, resolvePath } from '../../shared/tree'
import type { ConfigStore } from '../store/config'

export interface IpcContext {
  store: ConfigStore
  processes: ProcessManager
  /** 升级状态机。状态只在主进程里存一份，这里只读和触发 */
  updater: Updater
  /** 向所有存活窗口广播事件 */
  broadcast: (channel: string, payload: unknown) => void
}

/**
 * 把树里所有命令解析成可启动的参数。
 *
 * 独立成导出函数，是因为托盘菜单的「启动已标记」也要用它 —— 那处在主进程里、
 * 拿不到渲染进程的上下文，不能各写一遍解析逻辑。
 * 解析失败的命令（没绑定目录）直接跳过：批量启动应当尽力而为。
 *
 * `includeHidden: true` 是刻意的：隐藏只是「别在我的界面里占地方」，不是
 * 「别运行它」。一条被藏起来的命令如果被标记了，就该照常启动 —— 否则用户
 * 会得到一个「我明明标记了它却不启动」且毫无线索的哑故障。
 */
export function collectSpecs(
  store: ConfigStore,
  predicate?: (node: CommandNode) => boolean,
): SpawnSpec[] {
  const specs: SpawnSpec[] = []
  for (const command of collectCommands(store.nodes, null, { includeHidden: true })) {
    if (predicate && !predicate(command)) continue
    try {
      const node = command
      const cwd = resolvePath(store.nodes, node.id)
      if (!cwd) throw new Error('所属分组没有绑定项目目录')
      specs.push({
        id: node.id,
        label: node.name,
        command: node.command,
        cwd,
        shell: node.shell,
        env: node.env,
        expectedPort: node.expectedPort,
      })
    } catch (err) {
      console.warn(`[ipc] 跳过「${command.name}」：${(err as Error).message}`)
    }
  }
  return specs
}

/**
 * 「启动已标记」的目标：被标记为常驻命令的那些（`CommandNode.marked`）。
 *
 * 判据只留这一处 —— 托盘菜单和渲染进程的按钮都必须经由它。两边各写一遍
 * `node.marked` 的话，将来判据一变，静默走偏的那一侧表现出来只是
 * 「点了启动已标记，有些该起来的没起来」，没有任何报错、日志里也无线索。
 */
export function collectMarkedSpecs(store: ConfigStore): SpawnSpec[] {
  return collectSpecs(store, (node) => node.marked)
}

/**
 * 注册全部 IPC 处理器。
 *
 * 所有处理器都包成 `{ ok, data | error }` 信封：主进程抛出的异常若直接穿越
 * IPC 边界，渲染进程拿到的是一串带前缀的字符串，且极易变成未捕获的 Promise
 * rejection。信封让 preload 统一拆包并抛出干净的 Error。
 */
export function registerIpc(ctx: IpcContext): void {
  const { store, processes, updater, broadcast } = ctx

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return { ok: true as const, data: await fn(...(args as A)) }
      } catch (err) {
        console.error(`[ipc] ${channel} 处理失败：`, err)
        return { ok: false as const, error: (err as Error)?.message ?? String(err) }
      }
    })
  }

  const broadcastTree = (): void => broadcast(CH.EVT_TREE_CHANGED, store.nodes)

  /**
   * 命令节点 → 可执行的启动参数。
   *
   * 「执行目录」由**祖先链上最近一个绑定了 path 的分组**决定，命令自身不存路径。
   * 找不到就是配置不完整，直接报错而不是默默用主进程的 cwd —— 后者会让
   * dev server 在应用安装目录里启动，症状诡异且极难定位。
   */
  const resolveSpec = (id: string): SpawnSpec => {
    const node = store.find(id)
    if (!node) throw new Error(`命令不存在：${id}`)
    if (node.kind !== 'command') {
      throw new Error(`「${node.name}」是分组，不能直接启动，请选择分组下的命令`)
    }
    const cwd = resolvePath(store.nodes, id)
    if (!cwd) {
      throw new Error(`「${node.name}」所属的分组没有绑定项目目录，无法确定执行目录`)
    }
    return {
      id: node.id,
      label: node.name,
      command: node.command,
      cwd,
      shell: node.shell,
      env: node.env,
      expectedPort: node.expectedPort,
    }
  }

  // ---------------------------------------------------------------- 分组树

  handle(CH.TREE_LIST, () => store.nodes)

  handle(CH.TREE_CREATE_GROUP, (dto: GroupCreateDTO) => {
    const group = store.createGroup(dto)
    broadcastTree()
    return group
  })

  /**
   * 从目录建分组 —— 本工具的核心动作。
   *
   * 一次 IPC 内完成「读 package.json → 建分组 → 导入 scripts → 展开 workspaces」，
   * 而不是让渲染进程分多步调用：中途失败会留下半个树，用户看到的是
   * 一个莫名其妙只有分组没有命令的残缺状态。
   */
  handle(CH.TREE_CREATE_GROUP_FROM_DIR, async (dto: GroupFromDirDTO): Promise<GroupFromDirResult> => {
    const info = await readPackageInfo(dto.dir, dto.expandWorkspaces)
    const group = store.createGroup({
      parentId: dto.parentId,
      name: dto.name?.trim() || defaultGroupName(info),
      path: info.dir,
    })

    const toCommand = (key: string): string => scriptToCommand(info.packageManager, key)
    let createdCommands = 0
    let createdGroups = 0

    if (dto.importScripts) {
      createdCommands += store.addScriptCommands(group.id, info.scripts, toCommand).length
    }

    if (dto.expandWorkspaces) {
      for (const workspace of info.workspaces) {
        const sub = store.createGroup({
          parentId: group.id,
          name: workspace.name,
          path: workspace.dir,
        })
        createdGroups += 1
        if (dto.importScripts) {
          createdCommands += store.addScriptCommands(sub.id, workspace.scripts, toCommand).length
        }
      }
    }

    broadcastTree()
    return { group, createdCommands, createdGroups, warnings: info.warnings }
  })

  handle(CH.TREE_CREATE_COMMAND, (dto: CommandCreateDTO) => {
    const node = store.createCommand(dto)
    broadcastTree()
    return node
  })

  handle(CH.TREE_UPDATE, (dto: NodeUpdateDTO) => {
    const node = store.update(dto)
    if (!node) throw new Error(`节点不存在：${dto.id}`)
    broadcastTree()
    return node
  })

  handle(CH.TREE_DELETE, async (id: string) => {
    // 删除分组会连带删掉整棵子树。其中**正在运行**的命令必须先停掉：
    // 节点一消失，就再也没有入口能杀掉那条进程树，它会一直占着端口，
    // 而且用户在界面上完全看不到它。
    const doomed = [id, ...descendantIds(store.nodes, id)]
    for (const nodeId of doomed) {
      if (store.find(nodeId)?.kind === 'command') await processes.forget(nodeId)
    }

    const removed = store.remove(id)
    broadcastTree()
    return removed
  })

  handle(CH.TREE_MOVE, (dto: MoveNodeDTO) => {
    const ok = store.move(dto)
    broadcastTree()
    return ok
  })

  // ---------------------------------------------------------------- 目录扫描

  handle(CH.PKG_INSPECT, (dir: string) => readPackageInfo(dir, true))

  handle(CH.PKG_RESCAN, async (groupId: string): Promise<RescanResult> => {
    const group = store.find(groupId)
    if (group?.kind !== 'group') throw new Error(`分组不存在：${groupId}`)
    const dir = resolvePath(store.nodes, groupId)
    if (!dir) throw new Error(`「${group.name}」没有绑定项目目录，无从扫描`)

    const info = await readPackageInfo(dir, false)
    if (!info.found) throw new Error(`${dir} 下没有 package.json`)

    const result = store.applyRescan(groupId, info, (key) =>
      scriptToCommand(info.packageManager, key),
    )

    // monorepo：根分组的子分组各自绑着自己的子包目录，也要一起扫。
    // 否则用户点了「重新扫描」却发现子包里的新脚本没出现，只能挨个点。
    for (const child of store.nodes.filter((n) => n.parentId === groupId)) {
      if (child.kind !== 'group' || !child.path) continue
      const subInfo = await readPackageInfo(child.path, false)
      if (!subInfo.found) continue
      const sub = store.applyRescan(child.id, subInfo, (key) =>
        scriptToCommand(subInfo.packageManager, key),
      )
      result.added += sub.added
      result.newlyMissing += sub.newlyMissing
      result.restored += sub.restored
      result.updated += sub.updated
      result.warnings.push(...sub.warnings)
    }

    broadcastTree()
    return result
  })

  // ---------------------------------------------------------------- 进程控制

  handle(CH.PROCESS_START, (id: string) => processes.start(resolveSpec(id)))

  handle(CH.PROCESS_STOP, async (id: string) => {
    await processes.stop(id)
    return processes.get(id) ?? null
  })

  handle(CH.PROCESS_RESTART, (id: string) => processes.restart(resolveSpec(id)))

  handle(CH.PROCESS_START_ALL, () => processes.startAll(collectMarkedSpecs(store)))

  handle(CH.PROCESS_STOP_ALL, async () => {
    await processes.stopAll()
    return processes.snapshot()
  })

  handle(CH.PROCESS_SNAPSHOT, () => processes.snapshot())

  // ---------------------------------------------------------------- 日志

  handle(CH.LOG_SNAPSHOT, (id: string) => processes.retainedLog(id))

  handle(CH.LOG_CLEAR, (id: string) => {
    processes.clearLog(id)
    return true
  })

  // ---------------------------------------------------------------- 设置

  handle(CH.SETTING_GET, () => store.settings)

  handle(CH.SETTING_UPDATE, (patch: Partial<AppSettings>) => {
    const settings = store.updateSettings(patch)
    // 颜色开关会直接影响后续 spawn 的环境变量，必须立刻同步给进程管理器
    processes.updateSettings(settings)

    if (patch.autoLaunch !== undefined) {
      app.setLoginItemSettings({ openAtLogin: settings.autoLaunch })
    }

    /**
     * 换主题只需两步，渲染层不参与。
     *
     * 改 `themeSource` 会让所有渲染进程的 `prefers-color-scheme` 重新求值，
     * CSS 里的媒体查询自动接住；再刷新窗口底色，免得切到浅色后页面之外
     * 还留着深色边框。不需要给渲染进程发「请重绘」的通知。
     */
    if (patch.theme !== undefined) {
      applyThemeSource(settings.theme)
      refreshWindowBackgrounds()
    }

    broadcast(CH.EVT_SETTINGS_CHANGED, settings)
    return settings
  })

  // ---------------------------------------------------------------- 系统集成

  handle(CH.SHELL_OPEN_PATH, (target: string) => shell.openPath(target))

  /**
   * 外链白名单。
   *
   * 这些 URL 现在可以直接来自被监控进程的输出（日志里的链接是可点的），
   * 等于不可信输入：`shell.openExternal` 会把**任意协议**交给系统上注册的
   * 处理器 —— `file:` 能打开本地文件，各种自定义协议能拉起别的程序。所以
   * 只放行 http(s)，其余一律拒绝并把理由抛回渲染层（会显示成红色横幅）。
   */
  handle(CH.SHELL_OPEN_URL, async (raw: string) => {
    let parsed: URL
    try {
      parsed = new URL(String(raw))
    } catch {
      throw new Error(`链接格式不对，无法打开：${String(raw)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`只允许打开 http/https 链接，收到的是 ${parsed.protocol}`)
    }
    await shell.openExternal(parsed.href)
  })

  handle(CH.SHELL_PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: '选择项目根目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(CH.PORT_CHECK, (port: number) => checkPort(port))

  /**
   * 升级状态的两个接口。
   *
   * `snapshot` 不只是「初始化时读一次」：它同时是渲染层状态丢了之后的补救手段。
   * 界面上的升级状态完全来自广播事件，一旦错过一条（窗口还没建好、页面刚重载），
   * 界面就会永久停在一个错误的状态上。
   */
  handle(CH.UPDATE_SNAPSHOT, () => updater.state)

  // 返回完整的 UpdateState 而不是布尔值：调用方（设置弹窗里的按钮）需要拿到
  // 失败原因、有没有新版本等一切信息，多包一层「成功/失败 + 再查一次状态」只会
  // 让两边有两次机会对不上。
  handle(CH.UPDATE_CHECK, () => updater.check())

  handle(CH.UPDATE_DOWNLOAD, () => updater.download())

  handle(CH.UPDATE_CANCEL, () => updater.cancelDownload())

  /**
   * 打开安装包所在文件夹。
   *
   * 返回布尔而不是 void：「没有文件」和「打开了」对界面是两件事 —— 前者说明状态
   * 和磁盘已经不一致了，静默什么都不做只会让人反复点。
   */
  handle(CH.UPDATE_REVEAL, () => {
    const filePath = updater.state.filePath
    if (!filePath) return false
    shell.showItemInFolder(filePath)
    return true
  })

  /**
   * 静默安装并退出。
   *
   * 这个 handler 正常**不会把结果送回渲染层**：install() 会在起完安装器后直接
   * `app.exit(0)`。调用方（升级弹窗）因此必须假定「请求发出后进程就没了」，
   * 不能把按钮的 loading 状态寄望于这个 Promise 落地。
   */
  handle(CH.UPDATE_INSTALL, (options: { restartMarked?: boolean } | undefined) =>
    updater.install(options ?? {}),
  )

  handle(CH.ENV_INFO, () => ({
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    /**
     * 当前版本号。
     *
     * 取 `app.getVersion()` 而不是读 package.json：打包后前者来自真正的
     * 构建产物版本，后者在 asar 里读得到但可能和实际构建的那份不是同一个值。
     */
    version: app.getVersion(),
    /** 是不是安装版。开发态（electron-vite dev）下升级功能整体不参与 */
    packaged: app.isPackaged,
    /**
     * 本机环境里是否存在 NO_COLOR。
     *
     * 这不是猎奇信息：M0 实测发现本机确实设置了它，会让 vite/chalk 关闭颜色。
     * 界面据此解释「彩色输出」开关为什么默认是开的，避免用户以为是 bug。
     */
    noColorInEnv: Boolean(process.env.NO_COLOR),
  }))
}
