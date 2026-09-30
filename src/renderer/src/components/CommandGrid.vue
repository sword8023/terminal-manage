<script setup lang="ts">
import { computed } from 'vue'
import { collectCommands } from '@shared/tree'
import type { CommandNode, GroupNode } from '@shared/types'
import {
  breadcrumb,
  childGroups,
  dismissRescan,
  groupStats,
  rescanGroup,
  selectGroup,
  state,
  visibleCommands,
} from '../store/app'
import CommandCard from './CommandCard.vue'

const emit = defineEmits<{
  newCommand: [parentId: string]
  newGroup: [parentId: string | null]
  newProject: [parentId: string | null]
  editCommand: [node: CommandNode]
  visibility: [rootId: string | null, label: string]
}>()

/** 新建命令时的落点分组：选中分组，没选中就交给上层决定 */
const targetGroup = computed(() => state.selectedGroupId)

const rescan = computed(() => state.lastRescan)

const rescanText = computed(() => {
  const r = rescan.value
  if (!r) return ''
  const bits: string[] = []
  if (r.added) bits.push(`新增 ${r.added}`)
  if (r.newlyMissing) bits.push(`失效 ${r.newlyMissing}`)
  if (r.restored) bits.push(`恢复 ${r.restored}`)
  if (r.updated) bits.push(`更新 ${r.updated}`)
  return bits.length ? bits.join(' · ') : '没有变化'
})

/**
 * 标题行右侧的「N 条命令」与「命令可见性」按钮。
 *
 * 范围跟着当前选中的分组走，所以弹窗里列出的就是这片卡片区正在显示的那批
 * 命令（外加被隐藏的）—— 不必让用户猜「这次改的是哪些」。同一个入口，站在
 * 「全部」下编辑的就是所有项目，站在某个项目里编辑的就是那个项目。
 */
const scopeLabel = computed(() => {
  const chain = breadcrumb.value
  const last = chain.length ? chain[chain.length - 1] : undefined
  return last ? last.name : '全部'
})

const scopeCommands = computed(() =>
  collectCommands(state.nodes, state.selectedGroupId, { includeHidden: true }),
)

const scopeHidden = computed(() => scopeCommands.value.filter((cmd) => cmd.hidden).length)

/**
 * 当前范围内被标记为「常驻」的命令数。
 *
 * 刻意统计**当前范围**而不是全局：这一行讲的是「这个范围里有几条命令」，
 * 混一个全局数字进来只会让人对不上账。全局那个数在「启动已标记」按钮的
 * title 上（`启动已标记的 N 条命令`），因为真正被拉起的就是全局那批。
 */
const scopeMarked = computed(() => scopeCommands.value.filter((cmd) => cmd.marked).length)

const scopeCountText = computed(() => {
  const parts = [`${scopeCommands.value.length} 条命令`]
  if (scopeHidden.value) parts.push(`${scopeHidden.value} 隐藏`)
  if (scopeMarked.value) parts.push(`${scopeMarked.value} 已标记`)
  return parts.join(' · ')
})

const scopeCountTitle = computed(() => {
  const parts = [`当前范围内共 ${scopeCommands.value.length} 条命令`]
  if (scopeHidden.value) parts.push(`${scopeHidden.value} 条已隐藏`)
  if (scopeMarked.value) {
    parts.push(`${scopeMarked.value} 条已标记为常驻（点「启动已标记」时会一起启动）`)
  }
  return parts.join('，')
})

function onVisibility(): void {
  emit('visibility', state.selectedGroupId, scopeLabel.value)
}

function onChip(group: GroupNode): void {
  selectGroup(group.id)
}

function onRescan(): void {
  if (state.selectedGroupId) void rescanGroup(state.selectedGroupId)
}
</script>

<template>
  <section class="grid-pane">
    <header class="grid-head">
      <nav class="crumbs">
        <button class="crumb" :class="{ on: !state.selectedGroupId }" @click="selectGroup(null)">
          全部
        </button>
        <template v-for="group in breadcrumb" :key="group.id">
          <span class="sep">/</span>
          <button
            class="crumb"
            :class="{ on: group.id === state.selectedGroupId }"
            @click="selectGroup(group.id)"
          >
            {{ group.name }}
          </button>
        </template>
      </nav>

      <span class="count" :title="scopeCountTitle">{{ scopeCountText }}</span>

      <button
        class="btn ghost"
        title="编辑这个范围里哪些命令显示、哪些隐藏（改动立即生效）"
        @click="onVisibility"
      >
        命令可见性
      </button>

      <div class="spacer" />

      <button
        v-if="state.selectedGroupId"
        class="btn ghost"
        :disabled="Boolean(state.busy[state.selectedGroupId])"
        title="重新读取所属目录的 package.json，同步 script 的增删改"
        @click="onRescan"
      >
        重新扫描
      </button>
      <button class="btn ghost" @click="emit('newGroup', state.selectedGroupId)">＋子分组</button>
      <button
        class="btn"
        :disabled="!state.selectedGroupId"
        :title="state.selectedGroupId ? '' : '先选中一个分组，命令需要知道在哪个目录里跑'"
        @click="emit('newCommand', targetGroup ?? '')"
      >
        ＋ 新建命令
      </button>
    </header>

    <div v-if="rescan" class="note" :class="{ warn: rescan.warnings.length > 0 }">
      <span class="note-text">
        重新扫描完成：{{ rescanText }}
        <template v-if="rescan.warnings.length">
          —— {{ rescan.warnings.length }} 条提示：{{ rescan.warnings[0] }}
        </template>
      </span>
      <button class="icon-btn" title="关闭" @click="dismissRescan()">✕</button>
    </div>

    <div v-if="childGroups.length" class="chips">
      <button v-for="group in childGroups" :key="group.id" class="chip" @click="onChip(group)">
        <span class="chip-name">{{ group.name }}</span>
        <span v-if="groupStats(group.id).total > 0" class="chip-n">
          {{ groupStats(group.id).running }}/{{ groupStats(group.id).total }}
        </span>
      </button>
    </div>

    <div class="grid-body">
      <div v-if="visibleCommands.length === 0" class="empty">
        <p v-if="state.selectedGroupId">这个分组下还没有命令</p>
        <p v-else>还没有任何命令</p>
        <p class="dim">
          点右上角「＋ 新建命令」手写一条，
          <template v-if="state.selectedGroupId">或右键左侧分组「重新扫描 package.json」</template>
          <template v-else>或先新建一个项目</template>
        </p>
        <button
          v-if="!state.selectedGroupId"
          class="btn"
          @click="emit('newProject', null)"
        >
          ＋ 新建项目
        </button>
      </div>

      <div v-else class="cards">
        <CommandCard
          v-for="command in visibleCommands"
          :key="command.id"
          :node="command"
          @edit="(node) => emit('editCommand', node)"
          @new-command="(parentId) => emit('newCommand', parentId ?? '')"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid-pane {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.grid-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.crumbs {
  display: flex;
  overflow: hidden;
  align-items: center;
  gap: 2px;
}

.crumb {
  overflow: hidden;
  max-width: 160px;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.crumb:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.crumb.on {
  color: var(--text);
  font-weight: 600;
}

.sep {
  color: var(--text-faint);
  font-size: 12px;
}

/* 命令统计：贴着面包屑（标题）放，紧挨着它的还有「命令可见性」按钮。
   flex: none 是必要的 —— 面包屑长了要由它自己省略号收窄，不能把统计挤没。 */
.count {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--ok-soft);
  color: var(--text-dim);
  font-size: 12px;
}
.note.warn {
  background: var(--warn-soft);
}
.note-text {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--text);
}

.chips {
  display: flex;
  overflow-x: auto;
  gap: 6px;
  padding: 8px 12px 0;
}

.chip {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--text);
}

.chip-n {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.grid-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 12px;
}

.empty {
  padding: 40px 16px;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
}
.empty p {
  margin: 0 0 6px;
}
.empty .dim {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.9;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}
</style>
