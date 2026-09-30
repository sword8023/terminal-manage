/**
 * 主进程与渲染进程共享的类型定义。
 *
 * 这里是数据契约的唯一定义处 —— 两侧都从这里导入，避免类型漂移。
 */

// ---------------------------------------------------------------------------
// 持久化模型：可嵌套的分组树
// ---------------------------------------------------------------------------

export type ShellKind = 'cmd' | 'powershell'

/**
 * 树节点的公共字段。
 *
 * 整棵树以**扁平数组 + parentId 指针**存储，而不是嵌套对象：
 * 移动一个子树、重排同级、改父节点，都只是改一个指针加一个 order，
 * 不需要深拷贝。嵌套结构在这些操作上极易写错。
 */
interface NodeBase {
  id: string
  /** null = 根级 */
  parentId: string | null
  /** 同一父节点下的排序，升序。加载时按此字段归一化 */
  order: number
  createdAt: number
  updatedAt: number
}

/**
 * 分组：树里唯一的容器。
 *
 * `path` 是关键设计 —— 分组一旦绑定项目目录，它的**所有后代命令**默认都在
 * 该目录下执行。这样「读所属项目的 package.json」只需顺着 parentId 往上找
 * 最近一个带 path 的祖先，不必给每条命令各存一份路径，
 * 也就不会出现「这条命令到底在哪个目录跑」的歧义。
 */
export interface GroupNode extends NodeBase {
  kind: 'group'
  name: string
  /** 绑定的项目目录绝对路径；留空则继承父分组 */
  path?: string
  /** 展开状态持久化，省得每次重启都要重新点开 */
  expanded: boolean
}

export interface CommandNode extends NodeBase {
  kind: 'command'
  /** ★ 用户可编辑的展示名，如「前端开发服务器」—— 一眼知道在跑什么 */
  name: string
  /** 来源 script 的 key（如 dev）。手工创建的命令没有此项 */
  script?: string
  /** 真正执行的命令行，如 pnpm run dev */
  command: string
  /** 由 package.json 自动发现且用户没改过 —— 重新扫描时可安全覆盖 */
  autoDiscovered: boolean
  /**
   * 来源 script 已从 package.json 消失。
   *
   * 刻意**不删节点**：这个节点上可能已经有用户起的名字、隐藏设置、标记。
   * 因为一个 script 临时改名就把这些都扔掉，代价远大于留一个灰条。
   */
  missing?: boolean
  /** 隐藏后不在树中渲染，只能在设置页看到 */
  hidden: boolean
  /**
   * 是否标记为「常驻命令」—— 点「启动已标记」时**只**拉起被标记的这些。
   *
   * v3 之前这个字段叫 `autoStart`，语义是「随应用启动时自动运行」。那个触发
   * 时机被整个去掉了：打开工具就把一堆 dev server 拉起来并不是想要的，
   * 「哪些命令要跑」应该由用户在卡片上逐个标记、再手动点「启动已标记」。
   *
   * 名字跟着一起改，是因为让它继续叫 autoStart 会骗下一个读代码的人 ——
   * 现在既没有「自动」也没有「随应用启动」。
   */
  marked: boolean
  shell: ShellKind
  env?: Record<string, string>
  /** 预期端口，用于启动前冲突预检 */
  expectedPort?: number
  color?: string
}

export type TreeNode = GroupNode | CommandNode

export type ThemeMode = 'dark' | 'light' | 'system'

export interface AppSettings {
  theme: ThemeMode
  /** 每条命令保留的日志行数上限 */
  logBufferLines: number
  /** 关闭窗口时最小化到托盘而非退出 */
  minimizeToTray: boolean
  /** 开机自启 */
  autoLaunch: boolean
  /** 批量启动时命令之间的间隔（毫秒），避免同时抢占 CPU */
  launchDelayMs: number
  /** 日志区字号 */
  fontSize: number
  /**
   * 是否强制彩色输出。
   *
   * 注意：当环境变量中存在 NO_COLOR 时应保持 false —— 用户显式要求无颜色时
   * 不应被覆盖。若强行设置 FORCE_COLOR=1，Node 会在 stderr 输出
   * "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set."
   * 警告，污染日志首屏。此行为已由 M0 spike 实测确认。
   */
  forceColor: boolean
  /**
   * 树里是否显示已隐藏的命令。
   *
   * 这是「隐藏」功能的兜底开关：没有它的话，用户藏掉一条命令之后就再也
   * 找不到入口把它放出来。
   */
  showHiddenCommands: boolean
  /**
   * 右侧内容区上下分栏的比例：上方命令卡片占的高度百分比（0.15–0.85）。
   *
   * 存成比例而不是像素，是为了让它在窗口大小变化、以及换显示器之后依然合理。
   */
  splitRatio: number
  /**
   * 日志面板是否收起来（只留标题栏）。
   *
   * 默认收起：日志平时只是一片滚动噪声，真正需要它的时刻只有一个 —— 某条命令
   * 失败了。那种时刻由渲染层自动展开（见 store 里 EVT_PROCESS_EXIT 的处理），
   * 所以收起状态不会让人错过报错。
   */
  logCollapsed: boolean
}

export interface AppConfig {
  version: number
  nodes: TreeNode[]
  settings: AppSettings
}

// ---------------------------------------------------------------------------
// package.json 与 monorepo
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface PackageScript {
  /** scripts 里的 key，如 dev */
  key: string
  /** 脚本内容原文，用于界面展示与「这脚本到底干什么」的判断 */
  value: string
}

export interface PackageWorkspace {
  /** 子包目录绝对路径 */
  dir: string
  /** 子包 package.json 里的 name，缺省取目录名 */
  name: string
  scripts: PackageScript[]
}

export interface PackageInfo {
  /** package.json 所在目录 */
  dir: string
  /** 该目录是否存在 package.json */
  found: boolean
  name?: string
  /** 探测到的包管理器，决定命令前缀是 npm/pnpm/yarn/bun */
  packageManager: PackageManager
  scripts: PackageScript[]
  /** 声明的 workspaces 子包（glob 已展开，且各自读到了 scripts） */
  workspaces: PackageWorkspace[]
  /** 解析过程中的非致命问题，直接显示给用户（如 package.json 语法错误） */
  warnings: string[]
}

/** 重新扫描 package.json 后对树做的增量修正 */
export interface RescanResult {
  /** 新增的命令数 */
  added: number
  /** 因 script 消失而被标记 missing 的数量 */
  newlyMissing: number
  /** 因 script 回归而解除 missing 的数量 */
  restored: number
  /** 命令内容被自动跟随刷新（仍是 autoDiscovered）的数量 */
  updated: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 运行时模型（不持久化）
// ---------------------------------------------------------------------------

export type ProcessStatus =
  | 'idle' // 未启动
  | 'starting' // 已 spawn，等待就绪信号
  | 'running' // 运行中
  | 'stopping' // 正在执行 kill
  | 'exited' // 已退出（正常或异常）
  | 'error' // 启动失败

export interface RuntimeState {
  /** 命令节点 id —— 只有命令会被 spawn，分组没有运行时状态 */
  nodeId: string
  status: ProcessStatus
  pid?: number
  exitCode?: number | null
  signal?: string | null
  startedAt?: number
  /** 从日志中解析出的实际端口 */
  detectedPort?: number
  lastError?: string
  /** 区分「用户主动停止」与「意外崩溃」 */
  stoppedByUser?: boolean
}

/**
 * 一条命令被「解析」成可执行的启动参数。
 *
 * ProcessManager 只认这个结构，不认识树 —— 于是进程管理与数据模型解耦，
 * 「cwd 从哪个祖先分组继承」这类业务判断全部留在 ipc 层。
 */
export interface SpawnSpec {
  /** 命令节点 id，作为运行时状态的 key */
  id: string
  /** 日志首行的展示名 */
  label: string
  /** 实际执行的命令行 */
  command: string
  cwd: string
  shell: ShellKind
  env?: Record<string, string>
  expectedPort?: number
}

// ---------------------------------------------------------------------------
// 日志模型
// ---------------------------------------------------------------------------

export interface LogLine {
  /** 自增序列号，作为 v-for 的 key */
  seq: number
  /** 原始文本（含 ANSI 转义序列） */
  text: string
  /** 渲染后的 HTML 缓存（惰性填充） */
  html: string
}

export type LineEvent =
  | { type: 'append'; text: string } // 追加新行
  | { type: 'replace'; text: string } // 替换当前最后一行

export type LogBatch = {
  id: string
  events: LineEvent[]
}

export interface LogBatchPayload {
  nodeId: string
  events: LineEvent[]
}

export interface ExitInfo {
  nodeId: string
  code: number | null
  signal: string | null
  /** 区分「用户点了停止」与「进程自己崩了」 */
  stoppedByUser: boolean
}

export interface EnvInfo {
  platform: string
  electron: string
  node: string
  userData: string
  /** 本机环境变量里是否存在 NO_COLOR，用于向用户解释彩色开关 */
  noColorInEnv: boolean
}

// ---------------------------------------------------------------------------
// IPC 传输对象
// ---------------------------------------------------------------------------

export interface GroupCreateDTO {
  parentId: string | null
  name?: string
  path?: string
}

export interface GroupFromDirDTO {
  parentId: string | null
  /** 用户选中的项目根目录 */
  dir: string
  /** 显示名，缺省取 package.json 的 name 或目录名 */
  name?: string
  /** 是否把 workspaces 子包展开成子分组（monorepo 场景） */
  expandWorkspaces: boolean
  /** 是否把 scripts 自动导入为命令 */
  importScripts: boolean
}

export interface GroupFromDirResult {
  group: GroupNode
  /** 连带创建的命令节点数 */
  createdCommands: number
  /** 连带创建的 workspace 子分组数 */
  createdGroups: number
  warnings: string[]
}

export interface CommandCreateDTO {
  parentId: string
  name?: string
  command: string
  script?: string
  shell?: ShellKind
  env?: Record<string, string>
  marked?: boolean
  expectedPort?: number
  color?: string
}

export interface NodeUpdateDTO {
  id: string
  name?: string
  /** 仅分组 */
  path?: string
  /** 仅分组 */
  expanded?: boolean
  /** 仅命令 */
  command?: string
  /** 仅命令 */
  shell?: ShellKind
  env?: Record<string, string>
  marked?: boolean
  hidden?: boolean
  expectedPort?: number
  color?: string
}

export interface MoveNodeDTO {
  id: string
  newParentId: string | null
  /** 在新父节点下的目标下标 */
  index: number
}

export interface PortCheckResult {
  inUse: boolean
  pid?: number
  processName?: string
}
