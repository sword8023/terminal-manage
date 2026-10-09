import { CH } from './channels'
import type {
  AppSettings,
  CommandCreateDTO,
  CommandNode,
  EnvInfo,
  ExitInfo,
  GroupCreateDTO,
  GroupFromDirDTO,
  GroupFromDirResult,
  GroupNode,
  LogBatchPayload,
  MoveNodeDTO,
  NodeUpdateDTO,
  PackageInfo,
  PortCheckResult,
  RescanResult,
  RuntimeState,
  TreeNode,
  UpdateState,
} from './types'

/**
 * 事件通道 → payload 类型映射。
 *
 * 渲染进程调用 `api.on(channel, cb)` 时，cb 的参数类型由此推导：
 * 通道名写错、或读取了 payload 上不存在的字段，都会在编译期报错。
 */
export interface EventMap {
  [CH.EVT_PROCESS_STATUS]: RuntimeState
  [CH.EVT_PROCESS_LOG]: LogBatchPayload
  [CH.EVT_PROCESS_EXIT]: ExitInfo
  [CH.EVT_TREE_CHANGED]: TreeNode[]
  [CH.EVT_SETTINGS_CHANGED]: AppSettings
  [CH.EVT_UPDATE_STATUS]: UpdateState
}

export type EventChannel = keyof EventMap

/**
 * preload 通过 contextBridge 暴露给渲染进程的 API 契约。
 *
 * 渲染进程只能看到这张表 —— 拿不到 Node、拿不到 ipcRenderer，
 * 也无法向任意通道发消息。
 */
export interface TerminalManageApi {
  /** 分组树 */
  tree: {
    list(): Promise<TreeNode[]>
    createGroup(dto: GroupCreateDTO): Promise<GroupNode>
    /** 从目录建分组：读 package.json，可选展开 workspaces、自动导入 scripts */
    createGroupFromDir(dto: GroupFromDirDTO): Promise<GroupFromDirResult>
    createCommand(dto: CommandCreateDTO): Promise<CommandNode>
    update(dto: NodeUpdateDTO): Promise<TreeNode>
    /** 返回被连带删除的全部节点 id（含后代），主进程据此清理进程 */
    remove(id: string): Promise<string[]>
    move(dto: MoveNodeDTO): Promise<boolean>
    /** 重新读 package.json，增量补充新增命令、标记失效命令 */
    rescan(groupId: string): Promise<RescanResult>
  }
  /** package.json 解析（用于新建分组时的预览） */
  pkg: {
    inspect(dir: string): Promise<PackageInfo>
  }
  /**
   * 进程控制。这里的 id 一律是**命令节点**的 id ——
   * 分组是容器，不会被 spawn，也就没有运行时状态。
   */
  processes: {
    start(id: string): Promise<RuntimeState>
    stop(id: string): Promise<RuntimeState | null>
    restart(id: string): Promise<RuntimeState>
    startAll(): Promise<RuntimeState[]>
    stopAll(): Promise<RuntimeState[]>
    snapshot(): Promise<RuntimeState[]>
  }
  logs: {
    /** 取主进程侧保留的日志尾巴，用于界面重载后重放历史 */
    snapshot(id: string): Promise<string[]>
    clear(id: string): Promise<boolean>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  shell: {
    /** 在资源管理器中打开路径；返回空字符串表示成功 */
    openPath(target: string): Promise<string>
    openUrl(url: string): Promise<void>
    /** 弹出目录选择框；取消时返回 null */
    pickDir(): Promise<string | null>
  }
  port: {
    check(port: number): Promise<PortCheckResult>
  }
  env: {
    info(): Promise<EnvInfo>
  }
  /**
   * 更新检查、下载与安装。
   *
   * 这几个都返回**当前完整状态**而不是增量：调用方拿到的永远是一份自洽的快照，
   * 不必自己合并。
   */
  update: {
    /** 取主进程当前持有的状态，用于界面重载后立即回到正确的显示 */
    snapshot(): Promise<UpdateState>
    /** 强制检查，忽略自动检查的开关与任何节流 */
    check(): Promise<UpdateState>
    /**
     * 开始下载。返回时状态可能仍是 downloading —— 真正的进展由主进程经
     * EVT_UPDATE_STATUS 陆续广播，返回值只保证「这一刻的状态」。
     */
    download(): Promise<UpdateState>
    /** 取消正在进行的下载；没有下载时是空操作 */
    cancel(): Promise<UpdateState>
    /** 在文件管理器里选中已下载的安装包；没有文件时返回 false */
    reveal(): Promise<boolean>
    /**
     * 静默安装已下载的包并退出应用。
     *
     * `restartMarked`：升级完（应用重启后）要不要把「已标记」的命令一并拉起来。
     * 默认必须是关的 —— 见 docs/升级模块方案.md §7，随手拉起一堆 dev server
     * 正是本工具特意放弃的默认行为。
     *
     * 这个调用**正常不会返回**：调用方要预期「请求发出后进程就没了」，
     * 界面上的 loading 状态没有机会被自己清掉。
     */
    install(options: { restartMarked: boolean }): Promise<UpdateState>
  }
  /**
   * 订阅主进程推送的事件。
   *
   * @returns 取消订阅函数。组件卸载时**必须**调用 —— 否则监听器会不断累积，
   *   表现为同一条日志被渲染多次。
   */
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void
}
