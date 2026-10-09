import { computed, reactive } from 'vue'
import { CH } from '@shared/channels'
import { isMetaLine } from '@shared/log'
import { ancestorChain, childrenOf, collectCommands, findNode } from '@shared/tree'
import type {
  AppSettings,
  CommandCreateDTO,
  CommandNode,
  EnvInfo,
  ExitInfo,
  GroupFromDirDTO,
  GroupFromDirResult,
  GroupNode,
  LogLine,
  MoveNodeDTO,
  NodeUpdateDTO,
  RescanResult,
  RuntimeState,
  TreeNode,
  UpdateState,
} from '@shared/types'
import { lastUrl, toHtml } from '../utils/ansi'
import { isUp } from '../utils/status'

/**
 * 渲染进程持有的日志行。
 *
 * 比共享的 LogLine 多一个 `pending` 标记 —— 这是 `\r` 覆写语义在界面侧的落点：
 * 由 `\r` 产生、还没被换行符「定型」的那一行，后续的 replace 要原地改写它，
 * 被清空时要整行移除。
 */
interface RenderLine extends LogLine {
  pending: boolean
  /**
   * 这一行里最后一个 http(s) 链接，没有则为 null。
   *
   * 在造行的时候就顺手算出来存下，而不是让日志面板每次重渲染都回头扫一遍
   * 文本 —— 面板头部的「打开链接」入口要找「最近出现过的地址」，而 Vite 的
   * 地址打在第一屏、之后被成千上万行输出顶上去，每个批次都重扫一遍太亏。
   *
   * 工具自己的提示行（`[terminal-manage]` 开头）恒为 null：横幅会回显命令行，
   * 而命令行里可能带地址。见 `linkOf`。
   */
  link: string | null
}

interface State {
  ready: boolean
  /**
   * 扁平节点数组 —— 父子关系靠 parentId 指针表达。
   *
   * 这里刻意不建任何嵌套镜像：一旦本地再维护一份树形结构，
   * 主进程推送新数组时就多了一处需要同步的地方，漏同步会表现为
   * 「界面上的树和真实数据对不上」，且极难定位。
   */
  nodes: TreeNode[]
  /** nodeId → 运行时状态。只有命令节点会有条目 */
  runtime: Record<string, RuntimeState>
  /** nodeId → 日志行 */
  logs: Record<string, RenderLine[]>
  settings: AppSettings | null
  env: EnvInfo | null
  /**
   * 升级状态。**只读展示**，唯一的数据源是主进程的 Updater。
   *
   * 界面侧不存第二份、也不做「点了按钮就先显示正在检查」的乐观更新：一旦两边
   * 各自维护，就会出现「界面在转圈、主进程其实早就报错了」这种漂移，而升级
   * 恰恰是一个「错了也没人看得见」的功能。
   */
  update: UpdateState | null
  /** 右侧内容区当前查看的分组；null = 根级（看全树） */
  selectedGroupId: string | null
  /** 当前聚焦的命令 —— 日志面板跟着它走 */
  focusedId: string | null
  /** 正在执行 IPC 操作的节点（按钮置灰用）。计数而非布尔，避免并发时提前解禁 */
  busy: Record<string, number>
  /** 批量启动/停止进行中的层数 */
  busyAll: number
  /** 最近一次「非用户主动」的退出，用于提示崩溃 */
  lastCrash: ExitInfo | null
  /** 最近一次重新扫描的结果，用于在卡片区顶部提示新增/失效条数 */
  lastRescan: RescanResult | null
  /**
   * 一次「成功了但有问题」的操作留下的提醒，例如导入目录时跳过了几个子包。
   *
   * 与 error 分开是刻意的：这类情况操作其实已经生效（分组和命令都建好了），
   * 用报错的样式呈现会让用户以为失败了，然后重来一遍 —— 结果是建出两套。
   */
  notice: string | null
  error: string | null
}

export const state = reactive<State>({
  ready: false,
  nodes: [],
  runtime: {},
  logs: {},
  settings: null,
  env: null,
  update: null,
  selectedGroupId: null,
  focusedId: null,
  busy: {},
  busyAll: 0,
  lastCrash: null,
  lastRescan: null,
  notice: null,
  error: null,
})

/** v-for 的 key，全局唯一自增 */
let seqCounter = 0

/** 日志裁剪的摊还阈值：每来一行都 splice 一次的话，高吞吐下是 O(n²) */
const TRIM_CHUNK = 256

function trim(nodeId: string): void {
  const list = state.logs[nodeId]
  if (!list) return
  const max = state.settings?.logBufferLines ?? 5000
  const overflow = list.length - max
  if (overflow >= TRIM_CHUNK) list.splice(0, overflow)
}

/**
 * 这一行能提供什么链接。
 *
 * **只认被监控进程的真实输出。** terminal-manage 自己的横幅会把命令行原样回显，
 * 于是命令行文本里自带的地址（`curl http://内网/health`、`vite --host http://…`）
 * 会被当成「这条命令暴露的链接」混进卡片的下拉，用户点开看到一个根本没人监听的
 * 地址 —— 这比没有链接更误导人。判据抽在 src/shared/log.ts，与主进程共用。
 */
function linkOf(text: string): string | null {
  return isMetaLine(text) ? null : lastUrl(text)
}

function makeLine(text: string, pending: boolean): RenderLine {
  return { seq: ++seqCounter, text, html: toHtml(text), link: linkOf(text), pending }
}

/**
 * 把主进程的行事件落到日志数组上。
 *
 * 关键在 replace 的两种处境：
 *  - 界面上已有一条 pending 行 → 原地改写（或清空时移除）
 *  - 没有 pending 行 → 这是该活动行第一次露面，按新增处理
 *
 * 之所以不能简单地「替换最后一行」：LineBuffer 只在 `\r` 时发 replace，
 * 而屏幕上未必已经有一条对应的行（进度条的第一帧就是这种情况）。
 */
function pushLine(nodeId: string, text: string, replace: boolean): void {
  const list = (state.logs[nodeId] ??= [])
  const last = list[list.length - 1]

  if (replace) {
    if (last?.pending) {
      if (text === '') {
        // `\r` + 一串空格 + `\r`：终端里这就是「把这一行擦掉」
        list.pop()
      } else {
        last.text = text
        last.html = toHtml(text)
        last.link = linkOf(text)
      }
      return
    }
    // 没有可改写的行，且内容是空的 —— 无事可做
    if (text === '') return
    list.push(makeLine(text, true))
    return
  }

  // append：如果上一行正是同一条活动行（流结束时的 flush 会这样补一刀），
  // 就把它定型，而不是压出一条重复的行
  if (last?.pending) {
    if (last.text === text) {
      last.pending = false
      return
    }
    last.pending = false
  }
  list.push(makeLine(text, false))
}

// ---------------------------------------------------------------------------
// 树导航
// ---------------------------------------------------------------------------

export function nodeOf(id: string | null): TreeNode | null {
  return id ? (findNode(state.nodes, id) ?? null) : null
}

/** 只有命令能启动 —— 分组是容器，没有运行时状态 */
export function commandOf(id: string | null): CommandNode | null {
  const node = nodeOf(id)
  return node?.kind === 'command' ? node : null
}

/** 从根到该节点的分组链（含它自己），用于面包屑 */
export function groupChainOf(id: string | null): GroupNode[] {
  const chain: GroupNode[] = []
  const seen = new Set<string>()
  let cursor = id
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node = findNode(state.nodes, cursor)
    if (!node) break
    if (node.kind === 'group') chain.unshift(node)
    cursor = node.parentId
  }
  return chain
}

/**
 * 命令的工作目录来自**最近的带 path 的祖先分组**。
 *
 * 返回那个分组本身而不只是路径字符串：新建命令的弹窗要把「目录继承自哪里」
 * 显示给用户，光有路径说不出它是从哪个分组继承的。
 */
export function cwdSourceOf(commandId: string): GroupNode | null {
  const seen = new Set<string>()
  let cursor = findNode(state.nodes, commandId)?.parentId ?? null
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node = findNode(state.nodes, cursor)
    if (!node) return null
    if (node.kind === 'group' && node.path) return node
    cursor = node.parentId
  }
  return null
}

/** 树的渲染行：把嵌套结构摊平成一维，附带缩进层级 */
export interface TreeRow {
  node: TreeNode
  depth: number
  /** 分组是否有子节点 —— 用于决定要不要画折叠箭头 */
  expandable: boolean
}

export const treeRows = computed<TreeRow[]>(() => {
  const showHidden = state.settings?.showHiddenCommands ?? false
  const rows: TreeRow[] = []

  const walk = (parentId: string | null, depth: number): void => {
    for (const node of childrenOf(state.nodes, parentId)) {
      // 隐藏的命令直接从树里消失，只有设置页的「显示已隐藏」能让它们回来
      if (node.kind === 'command' && node.hidden && !showHidden) continue
      rows.push({
        node,
        depth,
        expandable: node.kind === 'group' && childrenOf(state.nodes, node.id).length > 0,
      })
      if (node.kind === 'group' && node.expanded) walk(node.id, depth + 1)
    }
  }

  walk(null, 0)
  return rows
})

/** 「新建项目 / 新建分组」下拉框里的一个候选父分组 */
export interface GroupOption {
  id: string
  name: string
  depth: number
}

/**
 * 整棵树里的**全部分组**，扁平成带层级的候选列表 —— 新建节点的父级下拉框用。
 *
 * 不能用 treeRows 过滤出来：那是给树渲染用的，折叠着的分组根本不在里面，隐藏的
 * 命令行还会连累整枝消失。而父级下拉框恰恰要能选到那个折叠着的分组 —— 用户正是
 * 因为在树里点不准它，才需要这个下拉框。
 *
 * seen 那道防线是防手编 config.json 里的父子环：normalizeTree 在加载时已经把环
 * 打散了，但主进程之后还会推新的 nodes 过来，这里多做一次自保 —— 没有它，环会让
 * 这个 computed 直接卡死整个渲染进程，代价只有一个 Set。
 */
export const groupOptions = computed<GroupOption[]>(() => {
  const out: GroupOption[] = []
  const seen = new Set<string>()

  const walk = (parentId: string | null, depth: number): void => {
    for (const node of childrenOf(state.nodes, parentId)) {
      if (node.kind !== 'group' || seen.has(node.id)) continue
      seen.add(node.id)
      out.push({ id: node.id, name: node.name, depth })
      walk(node.id, depth + 1)
    }
  }

  walk(null, 0)
  return out
})

/** 分组行上的聚合状态「2/3 运行中」 */
export const statsByGroup = computed<Map<string, { running: number; total: number }>>(() => {
  const map = new Map<string, { running: number; total: number }>()
  const bump = (groupId: string, up: boolean): void => {
    const cur = map.get(groupId) ?? { running: 0, total: 0 }
    cur.total += 1
    if (up) cur.running += 1
    map.set(groupId, cur)
  }

  for (const node of state.nodes) {
    if (node.kind !== 'command') continue
    const up = isUp(statusOf(node.id))
    // 逐级往上累加，根级统计由 rootStats 单独算
    const seen = new Set<string>()
    let cursor = node.parentId
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      bump(cursor, up)
      cursor = findNode(state.nodes, cursor)?.parentId ?? null
    }
  }
  return map
})

export function groupStats(groupId: string): { running: number; total: number } {
  return statsByGroup.value.get(groupId) ?? { running: 0, total: 0 }
}

export function statusOf(nodeId: string): RuntimeState['status'] {
  return state.runtime[nodeId]?.status ?? 'idle'
}

// ---------------------------------------------------------------------------
// 右侧内容区
// ---------------------------------------------------------------------------

export const selectedGroup = computed<GroupNode | null>(() => {
  const node = nodeOf(state.selectedGroupId)
  return node?.kind === 'group' ? node : null
})

export const breadcrumb = computed<GroupNode[]>(() =>
  state.selectedGroupId ? groupChainOf(state.selectedGroupId) : [],
)

/** 选中分组下的全部命令卡片（含所有层级，隐藏项按设置过滤） */
export const visibleCommands = computed<CommandNode[]>(() =>
  collectCommands(state.nodes, state.selectedGroupId, {
    deep: true,
    includeHidden: state.settings?.showHiddenCommands ?? false,
  }),
)

/** 选中分组的直接子分组 —— 卡片区顶部那一排下钻入口 */
export const childGroups = computed<GroupNode[]>(() =>
  childrenOf(state.nodes, state.selectedGroupId).filter((n): n is GroupNode => n.kind === 'group'),
)

/**
 * 被标记为「常驻」的命令 —— 点「启动已标记」时会被一起拉起的那批。
 *
 * 判据必须与主进程的 `collectMarkedSpecs`（src/main/ipc/index.ts）一致：
 * 看**整棵树**（不只是当前选中的分组 —— 用户标记的是「我平时要跑的命令」，
 * 跟他此刻在看哪一层无关），而且**不管隐藏与否**（隐藏只是不想让它占地方，
 * 被标记的命令照样该跑）。所以这里传 `null` + `includeHidden: true`。
 *
 * 两侧判据写两遍是有意的取舍：渲染层要拿它做「一条都没标记」的提示与计数，
 * 主进程要拿它决定真正拉起谁。真正定义「跑哪些」的只有主进程那一处。
 */
export const markedCommands = computed<CommandNode[]>(() =>
  collectCommands(state.nodes, null, { includeHidden: true }).filter((node) => node.marked),
)

export const markedCount = computed<number>(() => markedCommands.value.length)

/**
 * 正在运行的命令条数。
 *
 * 升级确认框要如实回答「这次升级会停掉几条」—— 「启动中」「停止中」也算在内：
 * 它们同样会被 dispose 一起收掉，只数 running 会少报，而少报正是让人点下确认
 * 之后才发现意料之外后果的那种错。
 */
export const runningCount = computed<number>(
  () =>
    Object.values(state.runtime).filter(
      (item) => item.status === 'running' || item.status === 'starting' || item.status === 'stopping',
    ).length,
)

export const focusedCommand = computed<CommandNode | null>(() => commandOf(state.focusedId))

export const activeRuntime = computed<RuntimeState | null>(() =>
  state.focusedId ? (state.runtime[state.focusedId] ?? null) : null,
)

export const activeLogs = computed<RenderLine[]>(() =>
  state.focusedId ? (state.logs[state.focusedId] ?? []) : [],
)

/** 全局统计，供标题栏的胶囊使用 */
export const overallStats = computed(() => {
  let running = 0
  let total = 0
  for (const node of state.nodes) {
    if (node.kind !== 'command') continue
    total += 1
    if (isUp(statusOf(node.id))) running += 1
  }
  return { running, total }
})

// ---------------------------------------------------------------------------
// 订阅与初始化
// ---------------------------------------------------------------------------

let disposers: Array<() => void> = []

/** 树被整体替换后，把指向已消失节点的选中状态收回来 */
function reconcileSelection(): void {
  const group = nodeOf(state.selectedGroupId)
  if (state.selectedGroupId && group?.kind !== 'group') state.selectedGroupId = null
  if (state.focusedId && !commandOf(state.focusedId)) state.focusedId = null
}

export async function init(): Promise<void> {
  // 先订阅、后拉快照。顺序反过来会有一个致命的空窗：
  // 快照返回之后、订阅生效之前产生的事件会永久丢失。
  // 先订阅的唯一副作用是这段窗口内可能有重复推送，而快照会整体覆盖日志，
  // 不会留下重影。
  disposers = [
    window.api.on(CH.EVT_PROCESS_STATUS, (runtime) => {
      state.runtime[runtime.nodeId] = runtime
    }),
    window.api.on(CH.EVT_PROCESS_LOG, ({ nodeId, events }) => {
      for (const evt of events) pushLine(nodeId, evt.text, evt.type === 'replace')
      trim(nodeId)
    }),
    window.api.on(CH.EVT_PROCESS_EXIT, (info) => {
      onProcessExit(info)
    }),
    window.api.on(CH.EVT_TREE_CHANGED, (nodes) => {
      state.nodes = nodes
      reconcileSelection()
    }),
    window.api.on(CH.EVT_SETTINGS_CHANGED, (settings) => {
      state.settings = settings
    }),
    window.api.on(CH.EVT_UPDATE_STATUS, (update) => {
      state.update = update
    }),
  ]

  try {
    const [nodes, settings, env, snapshot, update] = await Promise.all([
      window.api.tree.list(),
      window.api.settings.get(),
      window.api.env.info(),
      window.api.processes.snapshot(),
      window.api.update.snapshot(),
    ])

    state.settings = settings
    state.env = env
    state.nodes = nodes
    state.update = update
    for (const rt of snapshot) state.runtime[rt.nodeId] = rt

    // 重放主进程侧保留的日志尾巴：界面刷新后不该是空的
    const commandIds = nodes.filter((n) => n.kind === 'command').map((n) => n.id)
    const tails = await Promise.all(
      commandIds.map(async (id) => [id, await window.api.logs.snapshot(id)] as const),
    )
    for (const [id, lines] of tails) {
      if (lines.length === 0) continue
      state.logs[id] = lines.map((text) => makeLine(text, false))
    }
  } catch (err) {
    // 不能把异常抛出去：那样 ready 会永远停在 false，界面卡在「正在加载…」，
    // 而且 state.error 只在 guard 里写、启动路径根本走不到 —— 配置损坏、
    // 权限异常这些首次使用最可能踩到的情况，用户会面对一个没有线索的空壳。
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    state.ready = true
  }
}

export function dispose(): void {
  for (const off of disposers) off()
  disposers = []
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 统一的忙碌标记 + 错误捕获，避免每个 action 都重复 try/catch */
async function guard(id: string, fn: () => Promise<unknown>): Promise<void> {
  // 计数而不是布尔：同一个节点上并发两个操作时，先完成的那个会在 finally 里
  // 把标记清掉，后一个还在飞 —— 按钮提前解禁，用户能点出第二次请求。
  state.busy[id] = (state.busy[id] ?? 0) + 1
  state.error = null
  try {
    await fn()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    state.busy[id] = Math.max(0, (state.busy[id] ?? 1) - 1)
  }
}

async function guardAll(fn: () => Promise<unknown>): Promise<void> {
  state.busyAll += 1
  state.error = null
  try {
    await fn()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    state.busyAll = Math.max(0, state.busyAll - 1)
  }
}

/** 点树上的命令行：不只是聚焦日志，还要把右侧切到它所在的那一层 */
export function revealCommand(id: string): void {
  const node = commandOf(id)
  if (!node) return
  state.focusedId = id
  state.selectedGroupId = node.parentId
}

/**
 * 命令退出了。
 *
 * 这里有两件互不相干的事，故意分开判断：
 *  - `stoppedByUser` 决定要不要报「意外退出」横幅 —— 只有不是用户点的停止才值得
 *    报警，这正是本工具存在的意义。
 *  - `code !== 0` 决定要不要把日志摊开 —— 因为日志面板平时是收起的（用户要求），
 *    而收起状态下报错只留一行标题，等于把失败藏了。
 *
 * `code === 0` 是正常跑完（一次构建、一次 lint），既不算失败，也不该把收着的日志
 * 掀开打断人。`code === null` 会落进 `!== 0`，那正是被信号带走的情况，属于异常。
 */
function onProcessExit(info: ExitInfo): void {
  if (info.stoppedByUser) return
  state.lastCrash = info
  if (info.code === 0) return
  revealCommand(info.nodeId)
  if (state.settings?.logCollapsed) void updateSettings({ logCollapsed: false })
}

export function selectGroup(id: string | null): void {
  state.selectedGroupId = id
  // lastRescan 是全局的一份。切走分组后提示条还在，说的却是上一个分组的结果 ——
  // 「新增 3 条」配着一个根本没扫过的分组，比不提示更让人困惑。
  state.lastRescan = null
  // 切走之后日志面板不该还停在别的分组的命令上
  if (state.focusedId) {
    const focused = commandOf(state.focusedId)
    if (focused && !isWithin(focused.id, id)) state.focusedId = null
  }
}

/** 判断某节点是否位于指定分组之下（id 为 null 表示根，即全部） */
function isWithin(nodeId: string, groupId: string | null): boolean {
  if (groupId === null) return true
  const seen = new Set<string>()
  let cursor: string | null = nodeId
  while (cursor && !seen.has(cursor)) {
    if (cursor === groupId) return true
    seen.add(cursor)
    cursor = findNode(state.nodes, cursor)?.parentId ?? null
  }
  return false
}

export async function toggleGroup(id: string): Promise<void> {
  const node = nodeOf(id)
  if (node?.kind !== 'group') return
  // 展开状态直接落盘：重启后树保持原样，省得每次都要重新点开
  await guard(id, () => window.api.tree.update({ id, expanded: !node.expanded }))
}

export async function startNode(id: string): Promise<void> {
  await guard(id, async () => {
    state.focusedId = id
    await window.api.processes.start(id)
    if (state.lastCrash?.nodeId === id) state.lastCrash = null
  })
}

export async function stopNode(id: string): Promise<void> {
  await guard(id, () => window.api.processes.stop(id))
}

export async function restartNode(id: string): Promise<void> {
  await guard(id, async () => {
    state.focusedId = id
    await window.api.processes.restart(id)
    if (state.lastCrash?.nodeId === id) state.lastCrash = null
  })
}

export async function startAll(): Promise<void> {
  // 一条都没标记时不做「无操作的成功」：按钮点下去看起来生效了，实际一条都没
  // 起来，用户只会以为工具坏了。这里弹一句提示，把「标记在哪」直接告诉他。
  // 刻意不用 disabled 按钮 —— 禁用的按钮不解释自己为什么禁用，就是哑故障。
  if (markedCount.value === 0) {
    state.notice = '还没有标记任何命令 —— 点卡片右上角的 ☆ 标记要随「启动已标记」一起跑的命令'
    return
  }
  await guardAll(() => window.api.processes.startAll())
}

export async function stopAll(): Promise<void> {
  await guardAll(() => window.api.processes.stopAll())
}

export async function clearLog(id: string): Promise<void> {
  state.logs[id] = []
  await window.api.logs.clear(id)
}

/**
 * 下拉里最多列多少个链接。
 *
 * 去重之后这个数极少被顶到，但一条疯狂打 URL 的命令（比如反复重试的构建）
 * 能在几秒内产出成百上千个不同地址，全渲染出来就是个卡住界面的长列表。
 */
export const LINKS_MAX = 30

/**
 * 一条命令的输出里出现过的链接，按「最近出现」排序、去重。
 *
 * 用函数而不是顶层 computed：`state.logs` 按命令 id 索引，而卡片是按节点渲染的，
 * 没法为一个此刻还不知道 id 的命令预先算好。函数体里读了 `state.logs`，所以在
 * 卡片的 computed 里调用照样是响应式的。
 *
 * **倒序扫描**：dev server 重启后会再打一遍同一个地址，正序去重会让最早那次出现
 * 的位置说了算，而用户想要的几乎总是「最近这条命令给出的那个」。
 */
export function linksOf(nodeId: string): string[] {
  const list = state.logs[nodeId]
  if (!list) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = list.length - 1; i >= 0 && out.length < LINKS_MAX; i--) {
    const link = list[i]?.link
    if (!link) continue
    // `http://x/` 与 `http://x` 是同一个地址，去重时按去掉尾斜杠比
    const key = link.replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link)
  }
  return out
}

// ---------------------------------------------------------------------------
// 树的增删改
// ---------------------------------------------------------------------------

/**
 * 把某个分组连同它的所有祖先展开。
 *
 * 新建的节点要是落在折叠着的分组里，树上什么都看不见 —— 用户刚在下拉框里挑完
 * 父级、点了「创建」，界面却纹丝不动，只会以为没建成。父级下拉框一上线，这种
 * 情况从不常见变成了常态（下拉框里列着所有分组，包括折叠的），所以创建之后必须
 * 把这条路打开。
 *
 * 传的是**父分组**而不是新节点：主进程广播的新 nodes 不保证在这行代码之前到达
 * 渲染层，拿新节点去查祖先链很可能查不到。父分组本来就在 state.nodes 里，稳。
 */
async function expandBranch(groupId: string | null): Promise<void> {
  if (!groupId) return // 根级没有可展开的祖先
  const parent = findNode(state.nodes, groupId)
  if (!parent) return

  for (const node of [parent, ...ancestorChain(state.nodes, parent.id)]) {
    if (node.kind !== 'group' || node.expanded) continue
    await window.api.tree.update({ id: node.id, expanded: true })
  }
}

export async function createGroup(
  parentId: string | null,
  name?: string,
  path?: string,
): Promise<GroupNode | null> {
  let created: GroupNode | null = null
  await guardAll(async () => {
    created = await window.api.tree.createGroup({ parentId, name, path })
    const node = created
    if (node) {
      await expandBranch(parentId)
      state.selectedGroupId = node.id
    }
  })
  return created
}

/** 从目录建分组：读 package.json、可选展开 workspaces 与自动导入 scripts */
export async function importDir(dto: GroupFromDirDTO): Promise<GroupFromDirResult | null> {
  let result: GroupFromDirResult | null = null
  await guardAll(async () => {
    result = await window.api.tree.createGroupFromDir(dto)
    const done = result
    if (done) {
      await expandBranch(dto.parentId)
      state.selectedGroupId = done.group.id
      // warnings 是「跳过了什么」，不是「失败了」。分组和命令此刻已经建好，
      // 所以只能提示，不能当成失败让调用方重试 —— 重试会再建一整套。
      if (done.warnings.length) state.notice = done.warnings.join('；')
    }
  })
  return result
}

export async function createCommand(dto: CommandCreateDTO): Promise<CommandNode | null> {
  let created: CommandNode | null = null
  await guardAll(async () => {
    created = await window.api.tree.createCommand(dto)
    const node = created
    if (node) {
      state.selectedGroupId = node.parentId
      state.focusedId = node.id
    }
  })
  return created
}

export async function updateNode(dto: NodeUpdateDTO): Promise<void> {
  await guardAll(() => window.api.tree.update(dto))
}

export async function removeNode(id: string): Promise<void> {
  await guardAll(async () => {
    const removed = await window.api.tree.remove(id)
    for (const gone of removed) {
      delete state.logs[gone]
      delete state.runtime[gone]
    }
    if (state.focusedId && removed.includes(state.focusedId)) state.focusedId = null
    if (state.selectedGroupId && removed.includes(state.selectedGroupId)) {
      state.selectedGroupId = null
    }
  })
}

export async function moveNode(dto: MoveNodeDTO): Promise<void> {
  // 跨 IPC 之前必须摊成纯对象。ipcRenderer.invoke 走结构化克隆，而 Proxy 不在
  // 克隆算法支持的类型里 —— 调用方只要把 dto 塞进过 ref/reactive，传下来的就是个
  // Proxy，invoke 直接抛「An object could not be cloned」。界面上的症状是：提示线
  // 画得好好的、松手却什么都没发生，只在横幅里留一行看不懂的英文。
  // 在唯一的出口这里摊平，调用方就不必各自记得这件事。
  const plain: MoveNodeDTO = { id: dto.id, newParentId: dto.newParentId, index: dto.index }
  await guardAll(() => window.api.tree.move(plain))
}

export async function rescanGroup(groupId: string): Promise<RescanResult | null> {
  let result: RescanResult | null = null
  await guard(groupId, async () => {
    result = await window.api.tree.rescan(groupId)
    state.lastRescan = result
  })
  return result
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  await guardAll(() => window.api.settings.update(patch))
}

/**
 * 手动检查更新。
 *
 * **刻意不走 guardAll**：那只会在检查的几秒里把批量启动/停止按钮一起置灰。
 * 检查更新是个纯后台动作，用户点它的同时完全应该能继续启动自己的命令。
 *
 * 失败不必在这里判：主进程的 check 不抛异常，失败会作为 `phase: 'error'` 的
 * 状态回来（连错误文案都是它给的），同时还有一条 EVT_UPDATE_STATUS 广播。
 * 两条路径写的是同一份最终状态，不存在谁盖掉谁。
 */
export async function checkUpdate(): Promise<void> {
  try {
    state.update = await window.api.update.check()
  } catch (err) {
    // 走到这里说明是 IPC 本身出了问题（通道没注册、preload 拆包失败），
    // 那就和别的操作一样落到统一的错误横幅上
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 下载新版本。
 *
 * 同样不走 guardAll，理由与 checkUpdate 一致。返回值只用来确认「这一刻的状态」，
 * 之后进度靠 EVT_UPDATE_STATUS 一条条推回来 —— 所以这里写回 state.update 不是
 * 乐观更新，只是接住主进程刚给出的那份快照。
 */
export async function downloadUpdate(): Promise<void> {
  try {
    state.update = await window.api.update.download()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 取消正在进行的下载。
 *
 * 不写 state.update：真正的收尾（退回 available）是 download() 里 abort 之后的
 * catch 做的，那条路径会广播状态；这里再写一次只会和它抢最后写入权。
 */
export async function cancelUpdate(): Promise<void> {
  try {
    await window.api.update.cancel()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/** 在文件管理器里选中已下载的安装包（SmartScreen 拦下静默安装时的兜底出口） */
export async function revealUpdate(): Promise<void> {
  try {
    await window.api.update.reveal()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 静默安装并退出。
 *
 * 这个调用**正常不会返回**：主进程起完安装器就 `app.exit(0)`，本进程随即消失。
 * 因此这里刻意不写 state.update、也不在任何 finally 里清掉「安装中」的样子 ——
 * 界面必须一直保持那个状态直到进程自己没掉，否则用户会以为失败了再点一次。
 *
 * 唯一会走到下一行的情况是安装器根本没起来（Updater 会退回 ready + error），
 * 那时返回值里就有话可说了。
 */
export async function installUpdate(restartMarked: boolean): Promise<void> {
  try {
    state.update = await window.api.update.install({ restartMarked })
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 打开外部程序（默认浏览器 / 资源管理器）。
 *
 * 不能就地写成 `void window.api.shell.openUrl(...)`：preload 的 invoke 在
 * ok=false 时会 throw，void 掉就成了一条没人管的 rejection —— 系统没有默认
 * 浏览器、或资源管理器异常时，界面上毫无反应，只有控制台里一条红字。
 */
export async function openExternal(target: string, kind: 'url' | 'path' = 'path'): Promise<void> {
  try {
    if (kind === 'url') await window.api.shell.openUrl(target)
    else await window.api.shell.openPath(target)
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

export function dismissCrash(): void {
  state.lastCrash = null
}

export function dismissError(): void {
  state.error = null
}

export function dismissRescan(): void {
  state.lastRescan = null
}

export function dismissNotice(): void {
  state.notice = null
}
