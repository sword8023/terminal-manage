import type {
  CommandNode,
  GroupNode,
  MoveNodeDTO,
  ShellKind,
  TreeNode,
} from '@shared/types'

/**
 * 分组树的纯函数工具。
 *
 * 刻意不依赖 Electron：`store/config.ts` 要 `app.getPath('userData')` 才能
 * 确定配置文件位置，于是它无法被单元测试直接加载。把所有树的算法挪到这个
 * 无依赖模块里，树逻辑就能用 `node --test` 直接跑。
 */

export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) if (node.id === id) return node
  return undefined
}

export function isGroup(node: TreeNode | undefined): node is GroupNode {
  return node?.kind === 'group'
}

export function isCommand(node: TreeNode | undefined): node is CommandNode {
  return node?.kind === 'command'
}

/** 某个父节点下的直接子节点，按 order 升序 */
export function childrenOf(nodes: readonly TreeNode[], parentId: string | null): TreeNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
}

/** 后代 id（不含自身）。遇到环会在 visited 处自然收敛，不会死循环 */
export function descendantIds(nodes: readonly TreeNode[], id: string): string[] {
  const out: string[] = []
  const queue = [id]
  const seen = new Set([id])
  while (queue.length) {
    const current = queue.shift() as string
    for (const node of nodes) {
      if (node.parentId !== current || seen.has(node.id)) continue
      seen.add(node.id)
      out.push(node.id)
      queue.push(node.id)
    }
  }
  return out
}

/**
 * candidateId 是否位于 ancestorId 的子树内（含自身）。
 *
 * 移动节点前必须查这个：把分组拖进它自己的子分组里会让整棵子树从树上脱落，
 * 既不在任何父节点下、也无法再被界面访问。
 */
export function isDescendantOf(
  nodes: readonly TreeNode[],
  candidateId: string,
  ancestorId: string,
): boolean {
  if (candidateId === ancestorId) return true
  return descendantIds(nodes, ancestorId).includes(candidateId)
}

export function nextOrder(nodes: readonly TreeNode[], parentId: string | null): number {
  const siblings = childrenOf(nodes, parentId)
  const last = siblings[siblings.length - 1]
  return last ? last.order + 1 : 0
}

/** 把同一父下的 order 压成 0..n-1 —— 移动/删除之后调用，防止序号无限增长 */
export function normalizeOrders(nodes: TreeNode[], parentId: string | null): void {
  childrenOf(nodes, parentId).forEach((node, index) => {
    node.order = index
  })
}

/**
 * 解析一个节点的**有效工作目录**：自身有 path 就用，否则一路向上找最近的
 * 带 path 的祖先分组。
 *
 * 这就是「命令在哪个目录跑」的唯一答案来源。命令节点自身不存路径，
 * 从根上消除了「命令路径与所属项目路径不一致」这类 bug。
 */
export function resolvePath(nodes: readonly TreeNode[], nodeId: string): string | undefined {
  let cursor = findNode(nodes, nodeId)
  while (cursor) {
    if (cursor.kind === 'group' && cursor.path && cursor.path.trim()) return cursor.path
    cursor = cursor.parentId ? findNode(nodes, cursor.parentId) : undefined
  }
  return undefined
}

/** 从父到根的祖先链（不含自身），用于面包屑 */
export function ancestorChain(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const chain: TreeNode[] = []
  const seen = new Set<string>([id])
  let cursor = findNode(nodes, id)
  while (cursor?.parentId) {
    const parent = findNode(nodes, cursor.parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    chain.unshift(parent)
    cursor = parent
  }
  return chain
}

export interface CollectOptions {
  /** 是否递归收集后代分组的命令，默认 true */
  deep?: boolean
  /** 是否包含 hidden 的命令，默认 false */
  includeHidden?: boolean
}

/**
 * 收集某个分组下的命令节点。
 *
 * 传 null 表示整棵树 —— 「启动已标记」需要它。
 */
export function collectCommands(
  nodes: readonly TreeNode[],
  groupId: string | null,
  options: CollectOptions = {},
): CommandNode[] {
  const { deep = true, includeHidden = false } = options
  const out: CommandNode[] = []

  const walk = (parentId: string | null): void => {
    for (const node of childrenOf(nodes, parentId)) {
      if (node.kind === 'command') {
        if (!includeHidden && node.hidden) continue
        out.push(node)
      } else if (deep) {
        walk(node.id)
      }
    }
  }

  if (groupId === null) {
    walk(null)
    return out
  }

  const root = findNode(nodes, groupId)
  if (!root) return []
  // 选中命令本身时返回它自己，这样「启动当前选中的」不需要额外分支
  if (root.kind === 'command') return !root.hidden || includeHidden ? [root] : []
  walk(root.id)
  return out
}

/** 分组下（含后代）的运行中命令数与总数，用于折叠状态下的「2/3 运行中」 */
export function countCommands(
  nodes: readonly TreeNode[],
  groupId: string | null,
  isActive: (nodeId: string) => boolean,
): { active: number; total: number } {
  const list = collectCommands(nodes, groupId)
  return { active: list.filter((c) => isActive(c.id)).length, total: list.length }
}

/**
 * 把一个节点移到新父节点下的指定下标。
 *
 * 就地修改传入的数组。所有前置校验都在这里做，调用方不需要重复检查。
 */
export function moveNode(nodes: TreeNode[], dto: MoveNodeDTO): void {
  const node = findNode(nodes, dto.id)
  if (!node) throw new Error(`节点不存在：${dto.id}`)

  const oldParentId = node.parentId

  if (dto.newParentId !== null) {
    const parent = findNode(nodes, dto.newParentId)
    if (!parent) throw new Error(`目标分组不存在：${dto.newParentId}`)
    if (parent.kind !== 'group') throw new Error('命令不能作为容器，无法移动到它下面')
    if (isDescendantOf(nodes, dto.newParentId, node.id)) {
      throw new Error('不能把一个分组移动到它自己的子分组里')
    }
  }

  node.parentId = dto.newParentId

  // 先按当前顺序取出新父下的兄弟（此时已包含被移动的节点），
  // 把它挪到目标下标，再统一重排 order
  const siblings = childrenOf(nodes, dto.newParentId).filter((n) => n.id !== node.id)
  const index = Math.max(0, Math.min(dto.index, siblings.length))
  siblings.splice(index, 0, node)
  siblings.forEach((sibling, i) => {
    sibling.order = i
  })

  if (oldParentId !== dto.newParentId) normalizeOrders(nodes, oldParentId)
  node.updatedAt = Date.now()
}

/** 删除节点及其全部后代，返回被删掉的 id 列表（含自身） */
export function removeWithDescendants(nodes: TreeNode[], id: string): string[] {
  const doomed = new Set([id, ...descendantIds(nodes, id)])
  const parentId = findNode(nodes, id)?.parentId ?? null
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node && doomed.has(node.id)) nodes.splice(i, 1)
  }
  normalizeOrders(nodes, parentId)
  return [...doomed]
}

// ---------------------------------------------------------------------------
// 加载时清洗
// ---------------------------------------------------------------------------

const SHELLS: readonly ShellKind[] = ['cmd', 'powershell']

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 把磁盘上读到的任意内容洗成可用的树。
 *
 * 配置文件是**用户可见、可手工编辑的 JSON**，所以这里必须假设它什么都可能长：
 * 缺字段、多字段、parentId 指向不存在的节点、甚至自指成环。
 * 逐条修好并把损失记进 warnings，比直接清空重来对用户友好得多。
 */
export function normalizeTree(raw: unknown, warnings: string[]): TreeNode[] {
  if (!Array.isArray(raw)) return []

  const now = Date.now()
  const nodes: TreeNode[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = asString(rec.id)
    if (!id) {
      // 静默丢配置是这类工具最容易招骂的地方：用户手编过的 JSON 少了个 id，
      // 界面上的节点就凭空消失了，还没有任何提示。宁可记一条说不清是谁的警告。
      warnings.push('有一个节点缺少 id，已丢弃')
      continue
    }
    if (seen.has(id)) {
      warnings.push(`重复的节点 id ${id}，已丢弃后出现的那个`)
      continue
    }
    seen.add(id)

    const kind = rec.kind === 'group' ? 'group' : rec.kind === 'command' ? 'command' : null
    if (!kind) {
      warnings.push(`节点 ${id} 的 kind 非法，已丢弃`)
      seen.delete(id)
      continue
    }

    const parentId = asString(rec.parentId) ?? null
    const order = typeof rec.order === 'number' && Number.isFinite(rec.order) ? rec.order : 0
    const createdAt = typeof rec.createdAt === 'number' ? rec.createdAt : now
    const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : createdAt

    if (kind === 'group') {
      nodes.push({
        id,
        kind: 'group',
        parentId,
        order,
        name: asString(rec.name) ?? '未命名分组',
        path: asString(rec.path),
        expanded: rec.expanded !== false,
        createdAt,
        updatedAt,
      })
    } else {
      const shell = SHELLS.find((s) => s === rec.shell) ?? 'cmd'
      nodes.push({
        id,
        kind: 'command',
        parentId,
        order,
        name: asString(rec.name) ?? '未命名命令',
        script: asString(rec.script),
        command: asString(rec.command) ?? 'npm run dev',
        autoDiscovered: rec.autoDiscovered === true,
        missing: rec.missing === true ? true : undefined,
        hidden: rec.hidden === true,
        /**
         * v2 的配置里这个字段叫 `autoStart`（「随应用启动」）。两个键都认，
         * 是为了让老配置里勾过的命令不丢 —— 那些正是用户「平时要跑」的命令，
         * 语义上等价于现在的「已标记」。写回时只写 `marked`，见 CONFIG_VERSION。
         */
        marked: rec.marked === true || rec.autoStart === true,
        shell,
        env:
          rec.env !== null && typeof rec.env === 'object' && !Array.isArray(rec.env)
            ? (rec.env as Record<string, string>)
            : undefined,
        expectedPort: typeof rec.expectedPort === 'number' ? rec.expectedPort : undefined,
        color: asString(rec.color),
        createdAt,
        updatedAt,
      })
    }
  }

  // 父指针修复：指向不存在的节点、指向命令、或成环 —— 一律提到根级。
  // 提根而不是丢弃：节点里的命令配置是用户手工调过的，丢了不可恢复。
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const node of nodes) {
    if (node.parentId === null) continue
    const parent = byId.get(node.parentId)
    if (!parent) {
      warnings.push(`节点 ${node.name} 的父节点不存在，已提升到根级`)
      node.parentId = null
      continue
    }
    if (parent.kind !== 'group') {
      warnings.push(`节点 ${node.name} 挂在一条命令下面，已提升到根级`)
      node.parentId = null
      continue
    }
    // 成环检测：沿着父链往上走，若绕回自己说明有环
    const walked = new Set<string>([node.id])
    let cursor: TreeNode | undefined = parent
    while (cursor?.parentId) {
      if (walked.has(cursor.id)) {
        warnings.push(`节点 ${node.name} 的父链成环，已提升到根级`)
        node.parentId = null
        break
      }
      walked.add(cursor.id)
      cursor = byId.get(cursor.parentId)
    }
  }

  const parents = new Set<string | null>([null])
  for (const node of nodes) parents.add(node.parentId)
  for (const parentId of parents) normalizeOrders(nodes, parentId)

  return nodes
}
