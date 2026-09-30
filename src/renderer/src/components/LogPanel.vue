<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { activeLogs, clearLog, focusedCommand, openExternal, state } from '../store/app'
import { STATUS_TEXT } from '../utils/status'

const viewport = ref<HTMLElement | null>(null)

/**
 * 收起状态由 App.vue 持有（分栏高度也归它管，是唯一说了算的地方），这里只负责画。
 *
 * 收起来时整块 `.log-body` 会被 v-if 摘掉，不只是视觉上矮一截：日志动辄几千行的
 * `v-html`，留着它们等于让一屏看不见的内容继续参与布局与重绘。
 */
const props = defineProps<{ collapsed: boolean }>()

const emit = defineEmits<{ toggle: [] }>()

/**
 * stick = 视口是否粘在底部。
 *
 * 只有在用户本来就贴着底部时才自动滚 —— 否则他正在往上翻日志，
 * 一条新输出就把他顶回底部，没法看。
 */
const stick = ref(true)

const lines = activeLogs
const command = focusedCommand
const status = computed(() => state.runtime[state.focusedId ?? '']?.status ?? 'idle')

/**
 * 最近一次出现在日志里的链接（没有则为 null）。
 *
 * 只读行上现成的 `link` 字段，不重扫文本 —— 见 store 里 RenderLine 的说明。
 * Vite 把地址打在第一屏，之后被大量输出顶走，靠肉眼往回翻很不现实，
 * 头部这个入口就是给这种情况准备的。
 */
const latestUrl = computed<string | null>(() => {
  const list = lines.value
  for (let i = list.length - 1; i >= 0; i--) {
    const link = list[i]?.link
    if (link) return link
  }
  return null
})

/** 头部按钮只放得下一小段，去掉协议与尾部斜杠 */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

/**
 * 委派点击。
 *
 * 链接是 `v-html` 注入的、只有 `data-url` 没有 `href`（原因见 utils/ansi.ts），
 * 所以指望不上浏览器默认行为，得自己接住再走 IPC 交给系统浏览器。
 */
function onLogClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const el = target.closest('.log-link')
  const url = el instanceof HTMLElement ? el.dataset['url'] : undefined
  if (!url) return
  event.preventDefault()
  void openExternal(url, 'url')
}

function scrollToBottom(): void {
  const el = viewport.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = viewport.value
  if (!el) return
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function jumpToBottom(): void {
  stick.value = true
  scrollToBottom()
}

// 换命令时无条件拉回底部：上一个命令的位置对新命令没有意义
watch(
  () => state.focusedId,
  () => {
    stick.value = true
    void nextTick(scrollToBottom)
  },
)

// 同一命令有新行时，只在不打扰用户的前提下跟随
watch(
  () => lines.value.length,
  () => {
    if (stick.value) void nextTick(scrollToBottom)
  },
)

// 展开的那一刻视口才被重建。
//
// 不加这一手，用户看到的会是日志最顶上那几行 —— 而他想看的几乎总是最后报错的那
// 几行，于是还得自己往下拖一次。顺便把 stick 归位，否则上一次收起前若是停在中间
// （stick 为 false），展开后新输出也不再跟随。
watch(
  () => props.collapsed,
  (collapsed) => {
    if (collapsed) return
    stick.value = true
    void nextTick(scrollToBottom)
  },
)
</script>

<template>
  <section class="log-pane">
    <header class="log-head">
      <span v-if="command" class="dot" :class="status" />
      <span class="title">{{ command ? command.name : '日志' }}</span>
      <span v-if="command" class="pill" :class="status">{{ STATUS_TEXT[status] }}</span>
      <span v-if="command" class="count">{{ lines.length }} 行</span>
      <div class="spacer" />
      <button
        v-if="latestUrl"
        class="btn ghost sm link-btn"
        :title="'在浏览器里打开：' + latestUrl"
        @click="openExternal(latestUrl, 'url')"
      >
        ↗ {{ shortUrl(latestUrl) }}
      </button>
      <button
        v-if="command"
        class="btn ghost sm"
        :disabled="lines.length === 0"
        @click="clearLog(command.id)"
      >
        清空
      </button>
      <button
        class="btn ghost sm"
        :title="props.collapsed ? '展开日志面板' : '收起日志面板'"
        @click="emit('toggle')"
      >
        {{ props.collapsed ? '展开' : '收起' }}
      </button>
    </header>

    <div v-if="!props.collapsed" class="log-body">
      <div v-if="!command" class="empty">左侧点一条命令，这里显示它的实时输出</div>
      <div v-else-if="lines.length === 0" class="empty">还没有输出</div>
      <div
        v-else
        ref="viewport"
        class="viewport"
        :style="{ fontSize: (state.settings?.fontSize ?? 12) + 'px' }"
        @scroll="onScroll"
        @click="onLogClick"
      >
        <div
          v-for="line in lines"
          :key="line.seq"
          class="line"
          :class="{ pending: line.pending }"
          v-html="line.html"
        />
      </div>

      <button v-if="command && lines.length && !stick" class="jump" @click="jumpToBottom">
        ↓ 回到最新
      </button>
    </div>
  </section>
</template>

<style scoped>
.log-pane {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}

.dot {
  width: 7px;
  height: 7px;
  flex: none;
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

.title {
  font-size: 12px;
  font-weight: 600;
}

.count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.btn.sm {
  padding: 2px 8px;
  font-size: 12px;
}

.log-body {
  position: relative;
  min-height: 0;
  flex: 1;
}

.empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 12px;
}

.viewport {
  overflow: auto;
  height: 100%;
  padding: 8px 12px;
  font-family: var(--mono);
  line-height: 1.5;
}

.line {
  white-space: pre-wrap;
  word-break: break-all;
}
.line.pending {
  opacity: 0.75;
}

.jump {
  position: absolute;
  bottom: 12px;
  left: 50%;
  padding: 4px 12px;
  transform: translateX(-50%);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.jump:hover {
  border-color: var(--accent);
}

.link-btn {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--link);
}

/*
 * 链接是 v-html 注入的，拿不到 scoped 属性，只能走 :deep —— 直接写
 * `.log-link` 在这里会被编译成带 data-v 属性的选择器，一条都匹配不上。
 */
:deep(.log-link) {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
:deep(.log-link:hover) {
  color: var(--link-hover);
}
</style>
