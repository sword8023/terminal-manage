<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommandNode } from '@shared/types'
import CommandForm from './components/CommandForm.vue'
import CommandGrid from './components/CommandGrid.vue'
import GroupTree from './components/GroupTree.vue'
import LogPanel from './components/LogPanel.vue'
import NewNodeModal from './components/NewNodeModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import VisibilityModal from './components/VisibilityModal.vue'
import {
  dismissCrash,
  dismissError,
  dismissNotice,
  dispose,
  init,
  markedCount,
  nodeOf,
  overallStats,
  startAll,
  startNode,
  state,
  stopAll,
  updateSettings,
} from './store/app'

type Modal =
  | { kind: 'settings' }
  | { kind: 'visibility'; rootId: string | null; label: string }
  | { kind: 'node'; parentId: string | null; mode: 'project' | 'group' }
  | { kind: 'command'; node: CommandNode | null; parentId: string | null }

const modal = ref<Modal | null>(null)

onMounted(() => {
  void init()
})

// 订阅必须还回去。
//
// store 的 on() 返回取消订阅函数，init() 把它们收进 disposers；但 init() 每次
// 调用都会整体覆盖那个数组，所以不在这里解绑的话：旧句柄再也拿不回来（真泄漏），
// 而 Vite HMR 每热更一次 App.vue 就再挂一批 listener —— 同一条日志渲染多份、
// 状态与树事件被重复处理，越热越重。
onBeforeUnmount(dispose)

// ---------------------------------------------------------------------------
// 崩溃提示
// ---------------------------------------------------------------------------

const crashName = computed(() => {
  const crash = state.lastCrash
  if (!crash) return ''
  return nodeOf(crash.nodeId)?.name ?? crash.nodeId
})

// ---------------------------------------------------------------------------
// 上下分栏
// ---------------------------------------------------------------------------
//
// 拖拽期间只改本地 ratio（每帧都走 IPC 存盘既卡又没必要），
// 松手时才落盘。

const dragging = ref(false)
const ratio = ref(0.45)
const rightCol = ref<HTMLElement | null>(null)

watch(
  () => state.settings?.splitRatio,
  (value) => {
    if (typeof value === 'number' && !dragging.value) ratio.value = value
  },
  { immediate: true },
)

function onDividerDown(event: PointerEvent): void {
  const el = rightCol.value
  if (!el) return
  event.preventDefault()
  dragging.value = true
  const rect = el.getBoundingClientRect()

  const move = (moveEvent: PointerEvent): void => {
    const next = (moveEvent.clientY - rect.top) / rect.height
    ratio.value = Math.min(0.85, Math.max(0.15, next))
  }

  const finish = (persist: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    dragging.value = false
    if (persist) void updateSettings({ splitRatio: ratio.value })
  }

  const up = (): void => finish(true)
  // pointercancel：触摸屏/手写笔手势被系统接管时不会有 pointerup。
  // 少了它 dragging 会永远停在 true，此后 settings 里的比例再也同步不进来。
  const cancel = (): void => finish(false)

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
}

// ---------------------------------------------------------------------------
// 日志面板的收起 / 展开
// ---------------------------------------------------------------------------
//
// 收起不是「记住用户偏好」那么简单 —— 它成立的前提是失败时会自动摊开
// （见 store 里 EVT_PROCESS_EXIT 的处理）。少了那一环，收起就等于把报错一起藏了。

const logCollapsed = computed(() => state.settings?.logCollapsed ?? true)

function toggleLog(): void {
  void updateSettings({ logCollapsed: !logCollapsed.value })
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

function openCommand(node: CommandNode | null, parentId: string | null): void {
  modal.value = { kind: 'command', node, parentId }
}
</script>

<template>
  <div class="app">
    <header class="titlebar">
      <span class="brand">Terminal Manage</span>
      <span class="brand-sub">Vue 多项目终端</span>
      <div class="spacer" />
      <span class="pill-stat">
        {{ overallStats.running }} / {{ overallStats.total }} 运行中
      </span>
      <button
        class="btn"
        :disabled="Boolean(state.busyAll)"
        :title="
          markedCount > 0
            ? `启动已标记的 ${markedCount} 条命令`
            : '还没有标记任何命令 —— 点卡片右上角的 ☆ 标记要随「启动已标记」一起跑的命令'
        "
        @click="startAll()"
      >
        启动已标记
      </button>
      <button class="btn" :disabled="Boolean(state.busyAll)" @click="stopAll()">全部停止</button>
      <button class="btn ghost" @click="modal = { kind: 'settings' }">设置</button>
    </header>

    <div v-if="state.lastCrash" class="banner crash">
      <span class="banner-text">
        「{{ crashName }}」意外退出（退出码 {{ state.lastCrash.code ?? '-' }}），并非由你手动停止。
      </span>
      <button class="btn sm ghost" @click="startNode(state.lastCrash.nodeId)">重新启动</button>
      <button class="btn sm ghost" @click="dismissCrash()">知道了</button>
    </div>

    <div v-if="state.error" class="banner error">
      <span class="banner-text">{{ state.error }}</span>
      <button class="btn sm ghost" @click="dismissError()">关闭</button>
    </div>

    <div v-if="state.notice" class="banner notice">
      <span class="banner-text">{{ state.notice }}</span>
      <button class="btn sm ghost" @click="dismissNotice()">关闭</button>
    </div>

    <div v-if="!state.ready" class="loading">正在加载…</div>

    <div v-else class="body">
      <GroupTree
        @new-command="(parentId) => openCommand(null, parentId)"
        @new-group="(parentId) => (modal = { kind: 'node', parentId, mode: 'group' })"
        @new-project="(parentId) => (modal = { kind: 'node', parentId, mode: 'project' })"
        @edit-command="(node) => openCommand(node, null)"
        @visibility="(rootId, label) => (modal = { kind: 'visibility', rootId, label })"
      />

      <div ref="rightCol" class="right-col" :class="{ dragging, collapsed: logCollapsed }">
        <div class="grid-wrap" :style="logCollapsed ? undefined : { height: `${ratio * 100}%` }">
          <CommandGrid
            @new-command="(parentId) => openCommand(null, parentId || null)"
            @new-group="(parentId) => (modal = { kind: 'node', parentId, mode: 'group' })"
            @new-project="(parentId) => (modal = { kind: 'node', parentId, mode: 'project' })"
            @edit-command="(node) => openCommand(node, null)"
            @visibility="(rootId, label) => (modal = { kind: 'visibility', rootId, label })"
          />
        </div>

        <div class="divider" title="拖动调整上下比例" @pointerdown="onDividerDown" />

        <div class="log-wrap">
          <LogPanel :collapsed="logCollapsed" @toggle="toggleLog" />
        </div>
      </div>
    </div>

    <SettingsModal v-if="modal?.kind === 'settings'" @close="modal = null" />

    <VisibilityModal
      v-if="modal?.kind === 'visibility'"
      :root-id="modal.rootId"
      :root-label="modal.label"
      @close="modal = null"
    />

    <NewNodeModal
      v-if="modal?.kind === 'node'"
      :parent-id="modal.parentId"
      :mode="modal.mode"
      @close="modal = null"
    />

    <CommandForm
      v-if="modal?.kind === 'command'"
      :node="modal.node"
      :parent-id="modal.parentId"
      @close="modal = null"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
  flex-direction: column;
}

.titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.brand {
  font-size: 13px;
  font-weight: 600;
}

.brand-sub {
  color: var(--text-faint);
  font-size: 12px;
}

.pill-stat {
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
}
/* crash / error / notice 三套配色统一由 styles.css 定义，这里刻意不再重复：
   原先本地还写了一套，于是同一个类名有了两个答案（本地这套把 error 写成了
   琥珀色，而全局那套是红色）。红色给「出事了」，琥珀色留给「成功了但有话要说」。 */
.banner-text {
  flex: 1;
}

.btn.sm {
  padding: 2px 8px;
  font-size: 12px;
}

.loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 12px;
}

.body {
  display: flex;
  min-height: 0;
  flex: 1;
}

.right-col {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.right-col.dragging {
  cursor: row-resize;
  user-select: none;
}

.grid-wrap {
  display: flex;
  min-height: 0;
  flex-direction: column;
}

.divider {
  height: 5px;
  flex: none;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  cursor: row-resize;
}
.divider:hover {
  background: var(--accent);
}

.log-wrap {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/*
 * 收起状态：日志只剩标题栏，卡片区顺势铺满。
 *
 * 卡片区那个内联的高度在模板里按 logCollapsed 摘掉了，所以这里不用跟内联样式
 * 打架（`!important` 能赢，但会让「高度到底谁说了算」变成一件要靠搜代码才知道
 * 的事）。
 */
.right-col.collapsed .grid-wrap {
  height: auto;
  flex: 1;
}

/* 没有可拖的余地了，留着只会让人以为还能拉 */
.right-col.collapsed .divider {
  display: none;
}

.right-col.collapsed .log-wrap {
  flex: none;
}
</style>
