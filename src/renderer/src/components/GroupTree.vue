<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ancestorChain, childrenOf, descendantIds, findNode, resolvePath } from '@shared/tree'
import type { CommandNode, GroupNode, MoveNodeDTO, TreeNode } from '@shared/types'
import {
  groupStats,
  moveNode,
  revealCommand,
  selectGroup,
  state,
  statusOf,
  toggleGroup,
  treeRows,
  updateNode,
} from '../store/app'
import type { TreeRow } from '../store/app'
import NodeMenu from './NodeMenu.vue'

const emit = defineEmits<{
  newCommand: [parentId: string]
  newGroup: [parentId: string | null]
  newProject: [parentId: string | null]
  editCommand: [node: CommandNode]
  visibility: [rootId: string, label: string]
}>()

// ---------------------------------------------------------------------------
// 重命名：双击就地编辑
// ---------------------------------------------------------------------------
//
// 不用 window.prompt —— Electron 的渲染进程里它不可用（会直接返回 null）。
// 就地编辑还顺带避免了弹窗打断视线。

const renamingId = ref<string | null>(null)
const renamingText = ref('')

/**
 * 重命名输入框用「函数 ref」而不是 `ref="renameInput"`。
 *
 * 那个 input 位于 `v-for` 的作用域内，Vue 编译器会因此打上 `ref_for: true`，
 * 运行时 setRef 走数组分支，`renameInput.value` 拿到的是 `[input]` 而不是
 * input 本身 —— `?.focus()` 骗不过去，会抛 TypeError，而且是在 nextTick 之后
 * 的微任务里，没人捕获，界面上一点反应都没有（重命名直接不可用）。
 * 函数 ref 在 setRef 里优先于 `ref_for` 分支处理，收到的是元素本身。
 */
let renameEl: HTMLInputElement | null = null

function setRenameInput(el: unknown): void {
  renameEl = (el as HTMLInputElement | null) ?? null
}

async function beginRename(node: TreeNode): Promise<void> {
  renamingId.value = node.id
  renamingText.value = node.name
  await nextTick()
  renameEl?.focus()
  renameEl?.select()
}

function cancelRename(): void {
  renamingId.value = null
  // 必须把草稿一起清掉：Chromium 在移除聚焦元素时会补发 blur，而 blur 绑的是
  // commitRename —— 只关编辑态的话，用户按 Esc 反而会把刚敲的字提交上去。
  // 清空后 commitRename 开头的 !name 早退正好兜住。
  renamingText.value = ''
}

async function commitRename(node: TreeNode): Promise<void> {
  const name = renamingText.value.trim()
  renamingId.value = null
  if (!name || name === node.name) return
  await updateNode({ id: node.id, name })
}

// ---------------------------------------------------------------------------
// 缩进与归属参考线
// ---------------------------------------------------------------------------
//
// 层级原先只靠「往右挪一点」表达：深一级只差 14px，分组和命令又几乎长得一样
// （一个 12px 的箭头 vs 一个 7px 的圆点，标签左边缘还差 5px），扫一眼根本看不出
// 哪条命令挂在哪个分组下 —— 这正是用户说的「结构树不太明显」。这里做四件事：
//
//   1. 每一层画一条竖参考线，正好穿过该层祖先折叠箭头的中心，把父行和子行串起来；
//   2. 命令的状态点套进和箭头等宽的盒子，让同层的标签左边缘严格对齐；
//   3. 分组行加一层底色带，读起来像「小节标题」而不是「另一条命令」；
//   4. 鼠标停在某行上时把它的祖先分组一并提亮，直接回答「它属于谁」。

const INDENT_BASE = 6
const INDENT_STEP = 14

/** 折叠箭头盒子的半宽。参考线要落在箭头正中心，所以位移就是它；
    盒子的宽度在下面 .caret / .dot-box 里写死，改一处就得改另一处 */
const CARET_HALF = 8

/** 第 level 层参考线的横坐标；level 从 0 起，正好落在该层折叠箭头的中心 */
function railLeft(level: number): string {
  return `${INDENT_BASE + level * INDENT_STEP + CARET_HALF}px`
}

function indentOf(depth: number): string {
  return `${INDENT_BASE + depth * INDENT_STEP}px`
}

/** 悬停行 → 其祖先分组 id。不含被悬停的行本身。 */
const hoverId = ref<string | null>(null)
const ancestorIds = computed<Set<string>>(
  () => new Set(hoverId.value ? ancestorChain(state.nodes, hoverId.value).map((n) => n.id) : []),
)

// ---------------------------------------------------------------------------
// 拖拽改变归属
// ---------------------------------------------------------------------------
//
// 用原生 HTML5 拖放而不是自己撸 pointer 事件：Chromium 的原生拖拽自带「靠近
// 边缘自动滚动」和一张跟手的半透明拖影，这两样手写都要几十行且很难做得一样顺。
//
// 落点语义严格按**画出来的提示**来，不做隐式推断 —— 提示线画在两行之间，放下
// 去就是插到这两行之间；想塞进分组里，就把指针移到分组行的中间（整行亮起描边）。
//
// before/after 一律是「同一父级下的前/后一位」，没有例外。展开的分组那一行本来
// 就有这个问题：它的下一行是自己第一个子节点，「插到它后面」实际落在整棵子树
// 之后，线画在分组行的下沿就骗人了。解法不是改语义，而是把线**跟着落点走** ——
// 见 dropMarker：线会顺延到该子树里最后一个可见的行。语义简单，位置也永远诚实。

type DropZone = 'before' | 'after' | 'into'

interface DropTarget {
  /** 参照行的 id —— 提示线或高亮就画在这一行上 */
  id: string
  zone: DropZone
  /** 已经翻译好的移动参数；非法落点为 null */
  dto: MoveNodeDTO | null
  invalid: boolean
  reason: string
}

const draggingId = ref<string | null>(null)

/**
 * 落点必须用 shallowRef 而不是 ref。
 *
 * 落点每次都是整个换掉的一个新对象，从不需要深层响应式；而 ref 会把里面的 dto
 * 也包成 Proxy —— 那玩意儿过不了 IPC 的结构化克隆，松手时直接抛
 * 「An object could not be cloned.」。症状极具迷惑性：提示线与描边都画得完全
 * 正确，松手却什么都没发生。
 */
const dropTarget = shallowRef<DropTarget | null>(null)

const draggingNode = computed<TreeNode | null>(() =>
  draggingId.value ? (findNode(state.nodes, draggingId.value) ?? null) : null,
)

/**
 * 被拖节点自己 + 它的整棵子树。
 *
 * 这些行既不能当落点（主进程的 isDescendantOf 会直接抛「不能把一个分组移动到
 * 它自己的子分组里」），也要在拖拽期间显灰，明确告诉用户「这一整块都在跟着走」。
 */
const bannedIds = computed<Set<string>>(() => {
  const id = draggingId.value
  // descendantIds 按定义**不含自身**，这里必须自己加回去：漏掉的话分组可以拖到
  // 自己头上，主进程 isDescendantOf 对「自己」返回 true 直接抛错，界面上就是一条
  // 「不能把一个分组移动到它自己的子分组里」的红条 —— 而用户根本没往子级里拖。
  return id ? new Set([id, ...descendantIds(state.nodes, id)]) : new Set()
})

const dropHint = computed(() => (dropTarget.value?.invalid ? dropTarget.value.reason : ''))

interface DropMarker {
  /** 高亮「放进去」的那一行 */
  intoId: string | null
  /** 行间提示线画在哪一行 */
  lineId: string | null
  /** 线画在这一行的上沿还是下沿 */
  lineEdge: 'top' | 'bottom' | null
  invalid: boolean
}

/**
 * 落点提示实际画在哪里。
 *
 * 「插到 R 后面」在 R 是展开的分组时，真正落点在它整棵子树之后 —— 照着 treeRows
 * 的渲染顺序往后找到最后一个更深的行，把线顺延过去，线与落点就永远贴在一起。
 * 反过来，如果硬把线画在 R 自己的下沿、再把节点塞进子树尾部，用户看到的就是
 * 「线在这儿、节点飞到好几行之外」。
 */
const dropMarker = computed<DropMarker>(() => {
  const t = dropTarget.value
  if (!t) return { intoId: null, lineId: null, lineEdge: null, invalid: false }
  if (t.zone === 'into') return { intoId: t.id, lineId: null, lineEdge: null, invalid: t.invalid }

  let lineId = t.id
  if (t.zone === 'after') {
    // treeRows 是先序展开的扁平表，同一个分组的后代紧跟在它后面且 depth 更大，
    // 所以一路往后扫到 depth 不再更深为止，就是这棵子树的末尾
    const rows = treeRows.value
    const at = rows.findIndex((r) => r.node.id === t.id)
    if (at >= 0) {
      const depth = rows[at].depth
      for (let i = at + 1; i < rows.length && rows[i].depth > depth; i++) lineId = rows[i].node.id
    }
  }
  return {
    intoId: null,
    lineId,
    lineEdge: t.zone === 'before' ? 'top' : 'bottom',
    invalid: t.invalid,
  }
})

/**
 * 能不能把 node 挂到 newParentId 下面。放行返回空串，否则返回给用户看的原因。
 *
 * 判据与主进程 shared/tree.ts 的 moveNode 一致（目标必须是分组、不能进自己的
 * 子树），但这里多一条命令的「父级必须能解析出项目目录」。主进程允许命令挂在
 * 根级或挂在没有 path 的分组下，可一旦挂上去，那条命令就再也解析不出 cwd，
 * 启动时只会得到「所属分组没有绑定项目目录」，界面上表现为一张按不动的废卡片。
 * 与其让用户掉进去再自己爬出来，不如拖的时候就不让放。
 */
function parentAllowed(node: TreeNode, newParentId: string | null): string {
  if (newParentId === null) {
    return node.kind === 'group' ? '' : '命令只能放进分组'
  }
  const parent = findNode(state.nodes, newParentId)
  if (parent?.kind !== 'group') return '命令不能当容器'
  if (node.kind === 'command' && !resolvePath(state.nodes, newParentId)) {
    return `「${parent.name}」没有绑定项目目录`
  }
  return ''
}

/**
 * 把 node 插到 ref 的旁边（同一父级）。
 *
 * 先找 ref 在父级兄弟序列里的下标，再定在它前面或后面。被拖节点必须先从兄弟
 * 序列里剔掉再数下标 —— 不剔的话，「往后挪一位」会被它自己占的那个位置顶回来，
 * 看起来像拖了没反应。
 */
function siblingDto(node: TreeNode, ref: TreeNode, after: boolean): MoveNodeDTO {
  const siblings = childrenOf(state.nodes, ref.parentId).filter((n) => n.id !== node.id)
  const at = siblings.findIndex((n) => n.id === ref.id)
  const index = at < 0 ? siblings.length : after ? at + 1 : at
  return { id: node.id, newParentId: ref.parentId, index }
}

function check(node: TreeNode, id: string, zone: DropZone, dto: MoveNodeDTO): DropTarget {
  const reason = parentAllowed(node, dto.newParentId)
  return { id, zone, dto, invalid: reason !== '', reason }
}

/** 行内三段式：上下各 1/4 是同级插入，中间一半是「放进这个分组」 */
function zoneOf(event: DragEvent, node: TreeNode): DropZone {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (event.clientY - rect.top) / rect.height
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  // 命令行没有「里面」，中间那一段按「插到它下面」处理，免得多出一块点了没反应
  // 的死区
  return node.kind === 'group' ? 'into' : 'after'
}

function targetFor(node: TreeNode, ref: TreeNode, zone: DropZone): DropTarget {
  if (bannedIds.value.has(ref.id)) {
    return { id: ref.id, zone, dto: null, invalid: true, reason: '不能移动到自己的子级里' }
  }
  // 「放进分组」= 插到该分组第一个子节点的位置，也就是紧贴着分组头那一行。
  // 无需区分折叠/展开：折叠时它压根没有可见的子节点，index 0 是唯一合理的落点。
  if (zone === 'into') return check(node, ref.id, zone, { id: node.id, newParentId: ref.id, index: 0 })
  // before/after 一律是同父级的前/后一位，不看 ref 是分组还是命令、展开还是折叠。
  // 展开的分组会让落点和那一行错开好几行，这件事交给 dropMarker 用提示线的位置去
  // 说明，而不是在这里偷偷改语义 —— 语义一改，提示线就再也对不上落点了。
  return check(node, ref.id, zone, siblingDto(node, ref, zone === 'after'))
}

function onDragStart(event: DragEvent, node: TreeNode): void {
  // 正在重命名时按下的鼠标是想选词，不是想拖行
  if (renamingId.value) {
    event.preventDefault()
    return
  }
  closeMenu()
  hoverId.value = null
  draggingId.value = node.id
  dropTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 不 setData 的话 Chromium 会拒绝启动这次拖拽。内容没人读，真正的凭据是 draggingId。
    event.dataTransfer.setData('text/plain', node.id)
  }
}

function onDragEnd(): void {
  draggingId.value = null
  dropTarget.value = null
  clearExpand()
}

function onRowDragOver(event: DragEvent, row: TreeRow): void {
  const node = draggingNode.value
  if (!node) return
  const zone = zoneOf(event, row.node)
  const target = targetFor(node, row.node, zone)
  dropTarget.value = target
  // 非法落点故意不 preventDefault：让浏览器自己画禁止光标，drop 也不会触发。
  // 自己画一条红线再加一段说明，比「点了没反应」清楚得多。
  if (target.invalid) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  scheduleExpand(row, zone)
}

function onRowDragLeave(event: DragEvent, row: TreeRow): void {
  // 指针在行的子元素之间挪动也会触发 dragleave，不排除掉的话提示线会闪
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  if (dropTarget.value?.id === row.node.id) dropTarget.value = null
  clearExpand()
}

/**
 * 落在行的下方空白处 → 根级插入。
 *
 * 按纵坐标找出指针上方最后一个顶层行，插到它后面；一个都没有就插到第一个顶层行
 * 前面。不做「一律追加到根部末尾」—— 提示线画在两眼之间、节点却飞到列表另一头，
 * 那还不如不给这个落点。
 */
function onBodyDragOver(event: DragEvent): void {
  const node = draggingNode.value
  if (!node) return
  const roots = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.row.root')
  let anchor: HTMLElement | null = null
  for (const el of roots) {
    const rect = el.getBoundingClientRect()
    if (event.clientY > rect.top + rect.height / 2) anchor = el
  }
  let after = true
  if (!anchor) {
    anchor = roots[0] ?? null
    after = false
  }
  const refId = anchor?.dataset.id
  const ref = refId ? findNode(state.nodes, refId) : undefined
  if (!ref) return

  const target = check(node, ref.id, after ? 'after' : 'before', siblingDto(node, ref, after))
  dropTarget.value = target
  if (target.invalid) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

async function commitDrop(target: DropTarget | null): Promise<void> {
  clearExpand()
  draggingId.value = null
  dropTarget.value = null
  if (!target || target.invalid || !target.dto) return
  await moveNode(target.dto)
}

function onRowDrop(event: DragEvent, row: TreeRow): void {
  event.preventDefault()
  const target = dropTarget.value
  void commitDrop(target?.id === row.node.id ? target : null)
}

function onBodyDrop(event: DragEvent): void {
  event.preventDefault()
  void commitDrop(dropTarget.value)
}

// ---------------------------------------------------------------------------
// 悬停折叠分组时自动展开
// ---------------------------------------------------------------------------
//
// 不这么做的话，「插到某个子节点前面」在分组收起来的时候根本够不着 —— 只能先
// 松手、再展开、再重新拖一次。延迟 600ms 是为了让快速划过时不会被一路展开，
// 只有真的停在那里才展开。只在「放进去」区域生效：上下边缘那两段是同级插入，
// 中途把分组展开会让落点语义在拖拽过程中突然变掉。

let expandTimer: ReturnType<typeof setTimeout> | null = null
let expandPendingId: string | null = null

function clearExpand(): void {
  if (expandTimer !== null) clearTimeout(expandTimer)
  expandTimer = null
  expandPendingId = null
}

function scheduleExpand(row: TreeRow, zone: DropZone): void {
  const node = row.node
  if (zone !== 'into' || node.kind !== 'group' || node.expanded) {
    clearExpand()
    return
  }
  if (expandPendingId === node.id) return
  clearExpand()
  expandPendingId = node.id
  expandTimer = setTimeout(() => {
    expandTimer = null
    expandPendingId = null
    void toggleGroup(node.id)
  }, 600)
}

onBeforeUnmount(clearExpand)

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

const menu = ref<{ x: number; y: number; node: TreeNode } | null>(null)

function openMenu(event: MouseEvent, node: TreeNode): void {
  event.preventDefault()
  menu.value = { x: event.clientX, y: event.clientY, node }
}

function closeMenu(): void {
  menu.value = null
}

function onMenuRename(node: TreeNode): void {
  void beginRename(node)
}

// ---------------------------------------------------------------------------
// 行交互
// ---------------------------------------------------------------------------

const selectedId = computed(() => state.selectedGroupId)

function onRowClick(node: TreeNode): void {
  if (node.kind === 'group') {
    // 只调 action，不要顺手 state.focusedId = null。
    //
    // 面包屑与子分组胶囊走的是同一个 selectGroup，而它只在「聚焦的命令不在
    // 新分组里」时才清空焦点。组件直接改 store 的话，同一个「切到某分组」
    // 在树里点会关掉日志面板、在面包屑点则不会 —— 全项目唯一一处绕过 action 层。
    selectGroup(node.id)
    return
  }
  revealCommand(node.id)
}

function onCaret(event: MouseEvent, node: GroupNode): void {
  event.stopPropagation()
  void toggleGroup(node.id)
}

function pathLabel(node: GroupNode): string {
  if (!node.path) return ''
  const parts = node.path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? node.path
}
</script>

<template>
  <aside class="tree-pane">
    <header class="pane-head">
      <template v-if="draggingId === null">
        <span class="pane-title">项目</span>
        <div class="spacer" />
        <button class="icon-btn" title="新建项目（需要名称和路径）" @click="emit('newProject', null)">
          ＋项目
        </button>
        <button class="icon-btn" title="新建分组（只要名称）" @click="emit('newGroup', null)">
          ＋分组
        </button>
      </template>
      <span
        v-else
        class="drag-hint"
        :class="{ bad: !!dropHint }"
        :title="
          dropHint ||
          '拖到分组行的中间＝放进该分组；拖到两行之间＝插到该位置；拖到列表下方的空白＝移到根级'
        "
      >
        {{ dropHint || '拖到分组行中间＝放进该分组' }}
      </span>
    </header>

    <div
      class="tree-body"
      @click.self="closeMenu"
      @dragover="onBodyDragOver"
      @drop="onBodyDrop"
    >
      <div v-if="treeRows.length === 0" class="tree-empty">
        还没有任何项目或分组<br />
        点上面的「＋项目」添加一个 Vue 项目
      </div>

      <div
        v-for="row in treeRows"
        :key="row.node.id"
        class="row"
        :class="{
          group: row.node.kind === 'group',
          command: row.node.kind === 'command',
          root: row.depth === 0,
          active: row.node.kind === 'group' && row.node.id === selectedId,
          focused: row.node.kind === 'command' && row.node.id === state.focusedId,
          missing: row.node.kind === 'command' && row.node.missing,
          dimmed: row.node.kind === 'command' && row.node.hidden,
          ancestor: ancestorIds.has(row.node.id),
          doomed: bannedIds.has(row.node.id),
          'drop-before': dropMarker.lineId === row.node.id && dropMarker.lineEdge === 'top',
          'drop-after': dropMarker.lineId === row.node.id && dropMarker.lineEdge === 'bottom',
          'drop-into': dropMarker.intoId === row.node.id,
          'drop-bad': dropMarker.invalid && (dropMarker.intoId ?? dropMarker.lineId) === row.node.id,
        }"
        :style="{ paddingLeft: indentOf(row.depth) }"
        :data-id="row.node.id"
        :draggable="renamingId !== row.node.id"
        @click="onRowClick(row.node)"
        @dblclick="beginRename(row.node)"
        @contextmenu="openMenu($event, row.node)"
        @mouseenter="hoverId = row.node.id"
        @mouseleave="hoverId = hoverId === row.node.id ? null : hoverId"
        @dragstart="onDragStart($event, row.node)"
        @dragend="onDragEnd"
        @dragover.stop="onRowDragOver($event, row)"
        @dragleave="onRowDragLeave($event, row)"
        @drop.stop="onRowDrop($event, row)"
      >
        <span
          v-for="level in row.depth"
          :key="level"
          class="rail"
          :style="{ left: railLeft(level - 1) }"
        />

        <span
          v-if="row.node.kind === 'group'"
          class="caret"
          :class="{ open: row.node.expanded }"
          @click="onCaret($event, row.node)"
        >
          <svg v-if="row.expandable" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.5 4 L10.5 8 L5.5 12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>

        <span v-if="row.node.kind === 'command'" class="dot-box">
          <span class="dot" :class="statusOf(row.node.id)" :title="statusOf(row.node.id)" />
        </span>

        <input
          v-if="renamingId === row.node.id"
          :ref="setRenameInput"
          v-model="renamingText"
          class="rename-input"
          @click.stop
          @keydown.enter.prevent="commitRename(row.node)"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename(row.node)"
        />
        <template v-else>
          <span class="label">{{ row.node.name }}</span>

          <span
            v-if="row.node.kind === 'command' && row.node.missing"
            class="tag warn"
            title="package.json 里已经没有这个 script 了"
          >
            已失效
          </span>
          <span v-if="row.node.kind === 'command' && row.node.hidden" class="tag">已隐藏</span>

          <span v-if="row.node.kind === 'group' && groupStats(row.node.id).total > 0" class="count">
            {{ groupStats(row.node.id).running }}/{{ groupStats(row.node.id).total }}
          </span>

          <span v-if="row.node.kind === 'group' && pathLabel(row.node)" class="sub">
            {{ pathLabel(row.node) }}
          </span>
        </template>
      </div>
    </div>

    <NodeMenu
      v-if="menu"
      :node="menu.node"
      :x="menu.x"
      :y="menu.y"
      @close="closeMenu"
      @rename="onMenuRename"
      @edit="(node) => emit('editCommand', node)"
      @new-command="(parentId) => emit('newCommand', parentId ?? '')"
      @new-group="(parentId) => emit('newGroup', parentId)"
      @new-project="(parentId) => emit('newProject', parentId)"
      @visibility="(rootId, label) => emit('visibility', rootId, label)"
    />
  </aside>
</template>

<style scoped>
.tree-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 260px;
  min-width: 200px;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.pane-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.pane-title {
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

/*
 * 拖拽提示占用「标题 + 两个按钮」那一行，而不是另起一条浮动条：
 * 浮动条要么盖住底部的行、要么在拖拽开始时把整个树往下挤一截，两种都会让
 * 指针和落点在拖拽中途错位。
 */
.drag-hint {
  display: flex;
  align-items: center;
  overflow: hidden;
  flex: 1;
  /* 撑到和两个按钮一样高：否则拖拽一开始这一行会矮掉几个像素，整棵树往上一跳，
     指针和落点当场错位 */
  min-height: 22px;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drag-hint.bad {
  color: var(--danger);
}

.icon-btn {
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--bg-elev);
  border-color: var(--border-strong);
  color: var(--text);
}

.tree-body {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

.tree-empty {
  padding: 24px 16px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.9;
  text-align: center;
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-right: 8px;
  color: var(--text);
  font-size: 13px;
  cursor: default;
  user-select: none;
}

/*
 * 归属参考线。
 *
 * 一行只画属于自己祖先的那几层（depth 条），横坐标取该层折叠箭头的中心，
 * 于是上一层的线正好从上一层的箭头中间垂下来、从这一行箭头的左侧擦过 —— 连续
 * 的行高又让相邻两行的线接成一条，整棵树的骨架就出来了。
 */
.rail {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-strong);
  pointer-events: none;
}

/* 顶层项目之间拉开距离，否则上一个项目的最后一条命令会和下一个项目的标题挤在
   一起，看起来像同一个项目下的两条 */
.row.root {
  margin-top: 8px;
}
.row.root:first-child {
  margin-top: 0;
}

/*
 * 分组行铺一层底色带，读起来像「小节标题」；配合加粗，和命令行的差别就不再只是
 * 箭头和圆点的差别了。底色用 --bg-elev 而不是更重的 --bg-hover：深色下它是比
 * 面板略亮的一层，浅色下是比面板略亮的白，两种情况都只是「高一层」而不会抢戏。
 */
.row.group {
  background: var(--bg-elev);
  font-weight: 500;
}
.row.root.group {
  font-weight: 600;
}

.row:hover {
  background: var(--bg-hover);
}

/* 悬停某行时把它的祖先分组一并提亮 —— 「这条命令属于谁」不用再顺着线往上数 */
.row.ancestor {
  background: var(--bg-hover);
}
.row.ancestor .label {
  color: var(--accent);
}

.row.active {
  background: var(--accent-soft);
}
.row.focused {
  background: var(--accent-softer);
  box-shadow: inset 2px 0 0 var(--accent);
}
.row.missing .label,
.row.dimmed .label {
  color: var(--text-faint);
}
.row.dimmed .label {
  font-style: italic;
}

/* 跟着走的整棵子树。只改文字色不做整体降透明度：给拖拽源加 opacity/filter 会
   让 Chromium 重算拖影，拖起来一卡一卡的 */
.row.doomed .label {
  color: var(--text-faint);
}
.row.doomed .rail {
  background: var(--border);
}

/* 折叠箭头用内联 SVG 而不是「▸ / ▾」两个字形：那两个字符在 Windows 上要走字体
   回退，实际只画出四五像素高、粗细还随机器变，是这一栏看着小气的主因。改成 viewBox
   里定死的折线，尺寸处处一致；展开时靠旋转过渡，也不用来回换字形。
   盒子宽度 16px 必须和 railLeft 里的 CARET_HALF 对得上。 */
.caret {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 100%;
  flex: none;
  color: var(--text-dim);
  cursor: pointer;
}
.caret svg {
  width: 16px;
  height: 16px;
  transition: transform 120ms ease;
}
.caret.open svg {
  transform: rotate(90deg);
}
.row:hover .caret,
.row.ancestor .caret {
  color: var(--text);
}

/* 命令的状态点套进和折叠箭头等宽的盒子：不然同一层的分组标签和命令标签左边缘
   差 5px，纵向扫下来是斜的 */
.dot-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 100%;
  flex: none;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot.running {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}
.dot.starting,
.dot.stopping {
  background: var(--warn);
}
.dot.error {
  background: var(--danger);
}
.dot.exited {
  background: var(--text-dim);
}

.label {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename-input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text);
  font: inherit;
  outline: none;
}

.tag {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text-faint);
  font-size: 10px;
}
.tag.warn {
  color: var(--warn);
}

.count {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.sub {
  overflow: hidden;
  max-width: 72px;
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 落点提示。放在样式表最后：这几条与 .row.group / .row:hover / .row.active
 * 的优先级相同（都是两个类），靠书写顺序压过它们，拖拽中才不会被底色带吃掉。
 */
.row.drop-into {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.row.drop-before::before,
.row.drop-after::after {
  content: '';
  position: absolute;
  right: 6px;
  left: 6px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
.row.drop-before::before {
  top: 0;
}
.row.drop-after::after {
  bottom: 0;
}

/*
 * 非法落点只把上面几种提示**换成红色**，不额外画一圈红环。
 * 红环叠在蓝线上会变成「这条线到底行不行」的自相矛盾，而候选项的位置本身是有
 * 意义的（用户正指着那儿），必须照旧显示出来，只是告诉它不行。
 */
.row.drop-bad.drop-before::before,
.row.drop-bad.drop-after::after {
  background: var(--danger);
}
.row.drop-bad.drop-into {
  background: var(--danger-soft);
  box-shadow: inset 0 0 0 1px var(--danger);
}
</style>
