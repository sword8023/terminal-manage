<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { collectCommands, descendantIds } from '@shared/tree'
import type { CommandNode, TreeNode } from '@shared/types'
import {
  moveNode,
  removeNode,
  rescanGroup,
  startNode,
  state,
  statusOf,
  stopNode,
  treeRows,
  updateNode,
} from '../store/app'
import { isUp } from '../utils/status'

/**
 * 节点右键菜单 —— 树里的行与右侧卡片共用同一份。
 *
 * 菜单项里凡是「纯 store 调用」的（启动/隐藏/删除/移动/扫描）都在这里直接执行；
 * 凡是要动界面状态的（就地重命名、打开编辑弹窗、新建节点）则 emit 出去，
 * 由持有那些界面状态的一方决定怎么做。
 */
const props = defineProps<{ node: TreeNode; x: number; y: number }>()

const emit = defineEmits<{
  close: []
  rename: [node: TreeNode]
  edit: [node: CommandNode]
  newCommand: [parentId: string | null]
  newGroup: [parentId: string | null]
  newProject: [parentId: string | null]
  visibility: [rootId: string, label: string]
}>()

interface MenuItem {
  label: string
  run?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  /** 展开子级而不是关掉菜单（目前只有「移动到…」用），见 runItem */
  keepOpen?: boolean
}

const movePickerOpen = ref(false)

// 菜单贴着右下角出界时会被裁掉，先按视口夹一下
const pos = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - 230)}px`,
  top: `${Math.min(props.y, window.innerHeight - 300)}px`,
}))

function close(): void {
  emit('close')
}

function act(fn: () => void): void {
  close()
  fn()
}

/**
 * 菜单项点击。
 *
 * 「移动到…」是唯一不走 act() 的项：它不是「执行完就关」，而是把当前菜单原地
 * 换成目标列表。走 act() 的话会先 emit('close')，而父组件是 `v-if="menu"`，
 * 整个 NodeMenu 随即被销毁 —— 紧随其后的 movePickerOpen = true 落在一个正在
 * 卸载的组件上，界面毫无反应，看起来就是「移动到点了没反应」。
 */
function runItem(item: MenuItem): void {
  if (!item.run) return
  if (item.keepOpen) {
    item.run()
    return
  }
  act(item.run)
}

const items = computed<MenuItem[]>(() => {
  const node = props.node
  const list: MenuItem[] = []

  if (node.kind === 'command') {
    const up = isUp(statusOf(node.id))
    list.push({
      label: up ? '停止' : '启动',
      run: () => (up ? stopNode(node.id) : startNode(node.id)),
    })
    list.push({ label: '重命名', run: () => emit('rename', node) })
    list.push({ label: '编辑命令…', run: () => emit('edit', node) })
    list.push({ separator: true, label: '' })
    if (node.parentId) {
      // 常驻右键的第一项多半就是「在同组再加一条」
      list.push({ label: '在同一分组新建命令…', run: () => emit('newCommand', node.parentId) })
    }
    list.push({
      label: node.hidden ? '取消隐藏' : '隐藏此命令',
      run: () => updateNode({ id: node.id, hidden: !node.hidden }),
    })
    // 卡片头上那颗星也能切，这里再放一份是为了不破坏「右键能找到这条命令的
    // 全部属性」这个约定 —— 卡片只有一屏，树里滚到深处的命令照样能改
    list.push({
      label: node.marked ? '取消标记' : '标记为常驻命令',
      run: () => updateNode({ id: node.id, marked: !node.marked }),
    })
    list.push({
      label: '移动到…',
      keepOpen: true,
      run: () => (movePickerOpen.value = true),
    })
    list.push({ separator: true, label: '' })
    list.push({ label: '删除', danger: true, run: () => removeNode(node.id) })
    return list
  }

  list.push({ label: '新建命令…', run: () => emit('newCommand', node.id) })
  list.push({ label: '新建子分组', run: () => emit('newGroup', node.id) })
  list.push({ label: '在此新建项目…', run: () => emit('newProject', node.id) })
  list.push({ separator: true, label: '' })
  list.push({
    label: '重新扫描 package.json',
    disabled: !node.path,
    run: () => rescanGroup(node.id),
  })
  // 没有命令可勾选时给个灰项而不是让用户点开一个空弹窗 —— 菜单项变灰看得见，
  // 弹窗里只有一句「还没有命令」则像出了错。
  list.push({
    label: '编辑命令可见性…',
    disabled: collectCommands(state.nodes, node.id, { includeHidden: true }).length === 0,
    run: () => emit('visibility', node.id, node.name),
  })
  list.push({ label: '重命名', run: () => emit('rename', node) })
  list.push({
    label: node.path ? '打开所在目录' : '绑定项目目录…',
    run: async () => {
      if (node.path) {
        await window.api.shell.openPath(node.path)
        return
      }
      const dir = await window.api.shell.pickDir()
      if (dir) await updateNode({ id: node.id, path: dir })
    },
  })
  list.push({
    label: '解除目录绑定',
    disabled: !node.path,
    run: () => updateNode({ id: node.id, path: '' }),
  })
  list.push({ separator: true, label: '' })
  list.push({
    label: '移动到…',
    keepOpen: true,
    run: () => (movePickerOpen.value = true),
  })
  list.push({ separator: true, label: '' })
  list.push({ label: '删除分组', danger: true, run: () => removeNode(node.id) })
  return list
})

/**
 * 「移动到…」的候选目标，排除自己与自己的后代（主进程也会拒绝，但让用户
 * 点到一个必然失败的项没有意义）。
 *
 * 命令**不能移到根级** —— 工作目录是从最近的带 path 的祖先分组继承的，
 * 挂到根上就再也解析不出目录，会变成一张按不了「启动」的废卡片。
 */
const targets = computed<Array<{ id: string | null; label: string; depth: number }>>(() => {
  const node = props.node
  // descendantIds 不含自身，得自己加回去 —— 否则分组会在「移动到…」里把自己
  // 列成目标，点下去必然撞上主进程的「不能把一个分组移动到它自己的子分组里」。
  const banned = new Set([node.id, ...descendantIds(state.nodes, node.id)])
  const out: Array<{ id: string | null; label: string; depth: number }> = []
  if (node.kind === 'group') out.push({ id: null, label: '根级', depth: 0 })

  for (const row of treeRows.value) {
    if (row.node.kind !== 'group') continue
    if (banned.has(row.node.id)) continue
    out.push({ id: row.node.id, label: row.node.name, depth: row.depth + 1 })
  }
  return out
})

async function doMove(targetId: string | null): Promise<void> {
  const node = props.node
  close()
  // 菜单只有「目标」没有「位置」，一律追加到目标末尾；要精确摆位就用树里的拖拽
  await moveNode({ id: node.id, newParentId: targetId, index: 9999 })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click="close" @contextmenu.prevent="close" />
    <div class="menu" :style="pos" @click.stop>
      <template v-if="!movePickerOpen">
        <template v-for="(item, index) in items" :key="index">
          <div v-if="item.separator" class="menu-sep" />
          <button
            v-else
            class="menu-item"
            :class="{ danger: item.danger }"
            :disabled="item.disabled"
            @click="runItem(item)"
          >
            {{ item.label }}
          </button>
        </template>
      </template>

      <template v-else>
        <div class="menu-title">{{ props.node.name }} 移动到…</div>
        <div class="menu-scroll">
          <button
            v-for="target in targets"
            :key="target.id ?? '__root__'"
            class="menu-item"
            :style="{ paddingLeft: `${12 + target.depth * 12}px` }"
            @click="doMove(target.id)"
          >
            {{ target.label }}
          </button>
          <div v-if="targets.length === 0" class="menu-title">没有可用的目标</div>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  z-index: 40;
  inset: 0;
}

.menu {
  position: fixed;
  z-index: 41;
  min-width: 190px;
  max-height: 70vh;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev);
  box-shadow: var(--shadow-menu);
  overflow: auto;
}

.menu-title {
  padding: 6px 10px;
  color: var(--text-faint);
  font-size: 11px;
}

.menu-scroll {
  max-height: 46vh;
  overflow: auto;
}

.menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) {
  background: var(--bg-input);
}
.menu-item.danger {
  color: var(--danger);
}
.menu-item:disabled {
  color: var(--text-faint);
  cursor: default;
}

.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>
