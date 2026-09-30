<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { CommandNode } from '@shared/types'
import {
  cwdSourceOf,
  linksOf,
  openExternal,
  restartNode,
  startNode,
  state,
  statusOf,
  stopNode,
  updateNode,
} from '../store/app'
import { STATUS_TEXT, isUp } from '../utils/status'
import LinkMenu from './LinkMenu.vue'
import NodeMenu from './NodeMenu.vue'

const props = defineProps<{ node: CommandNode }>()

const emit = defineEmits<{
  edit: [node: CommandNode]
  newCommand: [parentId: string | null]
}>()

const status = computed(() => statusOf(props.node.id))
const up = computed(() => isUp(status.value))
const busy = computed(() => Boolean(state.busy[props.node.id]))
const focused = computed(() => state.focusedId === props.node.id)
const port = computed(() => state.runtime[props.node.id]?.detectedPort)

/**
 * 这条命令日志里出现过的地址（最近优先），见 store 里 linksOf 的说明。
 *
 * 用 computed 包一层是必要的：linksOf 每次调用都从头扫一遍缓冲，直接写进模板
 * 会让它在每次重渲染时都重扫。
 */
const logLinks = computed(() => linksOf(props.node.id))

/**
 * 下拉里的候选地址：探测到的端口排最前，再补日志里出现过、且与它不同的。
 *
 * 两种来源是互补而非重复 —— `detectedPort` 是从输出里正则抓来的，只有真打印过
 * 才有值，所以「有端口但日志里翻不到 URL」不会发生；反过来，一条命令也可能
 * 同时暴露好几个地址（前端 + mock 服务、monorepo 里各子包各自的端口）。
 */
const links = computed<string[]>(() => {
  const out: string[] = []
  const seen = new Set<string>()
  if (port.value) {
    const base = `http://localhost:${port.value}`
    out.push(base)
    seen.add(base)
  }
  for (const url of logLinks.value) {
    // `http://x/` 与 `http://x` 是同一个地址，去重时按去掉尾斜杠比
    const key = url.replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
})

/**
 * 什么时候给下拉按钮留位置。
 *
 * 端口胶囊已经能一键打开那个地址，「只有一个链接且它就是端口」时再放一个下拉
 * 纯属重复；多个地址、或唯一地址不是端口（比如接口文档、Mock 服务），才有得挑。
 */
const showLinks = computed(() => links.value.length > (port.value ? 1 : 0))

const linkMenu = ref<{ x: number; y: number } | null>(null)

function onLinks(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  linkMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

/**
 * 卡片的来源标记。
 *
 * 这个标记不只是装饰 —— 它决定了「重新扫描」会不会碰这张卡片：
 * 自动派生的卡片可以被脚本的增删改覆盖，手动建的卡片则完全不受影响。
 */
const sourceLabel = computed(() => {
  if (props.node.autoDiscovered) return '⚡ 自动读取'
  return props.node.script ? `✎ 手动 · ${props.node.script}` : '✎ 手动'
})

/** 工作目录继承自哪个分组 —— 一个没有可继承目录的命令是启动不了的 */
const cwdSource = computed(() => cwdSourceOf(props.node.id))

// ---------------------------------------------------------------------------
// 就地重命名
// ---------------------------------------------------------------------------

const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

async function beginRename(): Promise<void> {
  renaming.value = true
  draft.value = props.node.name
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

async function commitRename(): Promise<void> {
  const name = draft.value.trim()
  renaming.value = false
  if (!name || name === props.node.name) return
  await updateNode({ id: props.node.id, name })
}

/**
 * Esc 取消。
 *
 * 不能只写 `renaming = false`：Chromium 在移除聚焦元素时会补发 blur，
 * 而 blur 绑的是 commitRename，于是「取消」会把刚敲的字提交上去。
 * 清空草稿后 commitRename 开头的 !name 早退正好兜住。
 */
function cancelRename(): void {
  renaming.value = false
  draft.value = ''
}

// ---------------------------------------------------------------------------
// 复制命令行
// ---------------------------------------------------------------------------

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.node.command)
  } catch {
    // 剪贴板偶尔会被系统策略拒绝，不该因此炸掉界面
    return
  }
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1200)
}

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------

const menu = ref<{ x: number; y: number } | null>(null)

function openMenuAt(x: number, y: number): void {
  menu.value = { x, y }
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  openMenuAt(event.clientX, event.clientY)
}

function onMore(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openMenuAt(rect.left, rect.bottom + 4)
}

function toggle(): void {
  if (up.value) void stopNode(props.node.id)
  else void startNode(props.node.id)
}

function onRestart(): void {
  void restartNode(props.node.id)
}

/**
 * 标记 / 取消标记。
 *
 * 标记的含义只有一条：「启动已标记」会拉起哪些命令 —— 主进程侧的唯一判据是
 * `collectMarkedSpecs`（src/main/ipc/index.ts），这里只是把它翻过来。
 *
 * 刻意**常驻显示**而不是悬停才出现 —— 悬停才露出的星标等于没有，用户不会
 * 知道卡片能标记。未标记是淡色空心 ☆、已标记是强调色实心 ★，扫一眼就能从
 * 一片卡片里认出哪几张被标记了。
 */
async function toggleMarked(): Promise<void> {
  await updateNode({ id: props.node.id, marked: !props.node.marked })
}

function openPort(): void {
  if (port.value) void openExternal(`http://localhost:${port.value}`, 'url')
}

function openPath(): void {
  const dir = cwdSource.value?.path
  if (dir) void openExternal(dir, 'path')
}
</script>

<template>
  <article
    class="card"
    :class="{
      focused,
      missing: props.node.missing,
      hidden: props.node.hidden,
      running: status === 'running',
      busy: status === 'starting' || status === 'stopping',
      failed: status === 'error',
    }"
    @contextmenu="onContextMenu"
  >
    <header class="card-head">
      <span class="dot" :class="status" />
      <span class="tag source" :title="props.node.script ? `来自 script：${props.node.script}` : ''">
        {{ sourceLabel }}
      </span>
      <div class="spacer" />
      <button
        class="star"
        :class="{ on: props.node.marked }"
        :title="
          props.node.marked
            ? '已标记：点「启动已标记」时会一起启动（再点一下取消标记）'
            : '标记为常驻命令 —— 点「启动已标记」时会一起启动'
        "
        @click.stop="toggleMarked"
      >
        {{ props.node.marked ? '★' : '☆' }}
      </button>
    </header>

    <div class="card-title">
      <input
        v-if="renaming"
        ref="input"
        v-model="draft"
        class="rename-input"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="name" :title="`${props.node.name}（双击改名）`" @dblclick="beginRename">{{
        props.node.name
      }}</span>
    </div>

    <div class="cmd" :title="`点击复制：${props.node.command}`" @click="copy">
      <code>{{ props.node.command }}</code>
      <span v-if="copied" class="copied">已复制</span>
    </div>

    <div class="meta">
      <span class="pill" :class="status">{{ STATUS_TEXT[status] }}</span>
      <span v-if="port" class="pill port" title="在浏览器中打开" @click="openPort">:{{ port }}</span>
      <button
        v-if="showLinks"
        class="pill links"
        :title="`选择要打开的链接（共 ${links.length} 个）`"
        @click="onLinks"
      >
        🔗 {{ links.length }}
      </button>
      <span v-if="props.node.missing" class="tag warn" title="package.json 里已经没有这个 script 了">
        脚本已不存在
      </span>
      <span v-if="props.node.hidden" class="tag">已隐藏</span>
      <div class="spacer" />
      <span
        class="cwd"
        :class="{ warn: !cwdSource }"
        :title="cwdSource ? cwdSource.path : '所属的分组都没有绑定项目目录，这条命令无法启动'"
        @click="openPath"
      >
        {{ cwdSource ? cwdSource.name : '未绑定目录' }}
      </span>
    </div>

    <footer class="card-foot">
      <button class="btn sm" :disabled="busy" @click="toggle">
        {{ up ? '⏹ 停止' : '▶ 启动' }}
      </button>
      <button class="btn sm ghost" :disabled="busy || !up" @click="onRestart">重启</button>
      <div class="spacer" />
      <button class="btn sm ghost" @click="emit('edit', props.node)">编辑</button>
      <button class="btn sm ghost" title="更多" @click="onMore">⋯</button>
    </footer>

    <LinkMenu
      v-if="linkMenu"
      :urls="links"
      :x="linkMenu.x"
      :y="linkMenu.y"
      @close="linkMenu = null"
    />

    <NodeMenu
      v-if="menu"
      :node="props.node"
      :x="menu.x"
      :y="menu.y"
      @close="menu = null"
      @rename="beginRename"
      @edit="(node) => emit('edit', node)"
      @new-command="(parentId) => emit('newCommand', parentId)"
    />
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
}
.card:hover {
  border-color: var(--border-strong);
}

/*
 * 状态底色：整张卡片跟着运行状态换色，而不是只让那个 8px 的状态点变绿。
 *
 * 卡片网格的实际用法就是「扫一眼看谁在跑」—— 一屏十几张卡片时，一个 8px 的
 * 小圆点根本认不出来，整张换底加左侧一道 3px 色条才是扫视时看得见的信息。
 * busy（启动中/停止中）与 failed 走同一条路子，只是换色：它们同样需要被一眼
 * 看见，而且都比「空闲」更该醒目。
 */
.card.running {
  border-color: var(--card-running-border);
  background: var(--card-running-bg);
  box-shadow: inset 3px 0 0 var(--ok);
}
.card.busy {
  border-color: var(--card-busy-border);
  background: var(--card-busy-bg);
  box-shadow: inset 3px 0 0 var(--warn);
}
.card.failed {
  border-color: var(--card-error-border);
  background: var(--card-error-bg);
  box-shadow: inset 3px 0 0 var(--danger);
}

/* 选中态必须排在上面三条之后：同优先级下后者胜出，否则「运行中且被选中」的
   卡片会丢掉蓝色的选中边框 —— 而选中决定了下半区日志面板显示谁。 */
.card.focused {
  border-color: var(--accent);
}

.card.missing {
  opacity: 0.62;
}
.card.hidden {
  border-style: dashed;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot.running {
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
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

/*
 * 标记星：可点的属性开关，放在卡片头最右端（名字之后）。
 *
 * 与「⚡ 自动读取 / ✎ 手动」的来源标记对调过位置：来源标记是纯信息，贴着状态点
 * 和名字读更顺；星标是这一行里唯一的开关，放最右端之后每张卡片都落在同一条竖线
 * 上（名字是 flex:1，会把它顶到右边缘），扫视一列卡片不必左右找。
 *
 * 图标放大到 16px 并留出点击内边距 —— 它是要被点的，13px 时命中区只有十几个
 * 像素宽，容易点空。
 *
 * 已标记用强调色，刻意不用金色（--warn）：金色在这套界面里已经表示「启动中 /
 * 停止中」，一颗金星星会被误读成「这条正忙」。也刻意不给整张卡片换底色 ——
 * 底色已经被运行状态占了，两套颜色叠加会互相淹没，反而更看不清。
 */
.star {
  flex: none;
  padding: 0 3px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.star.on {
  color: var(--accent);
}
/* 悬停一律提亮到正文色；已标记时从强调色变成正文色，正好暗示「再点一下
   就是取消」。 */
.star:hover,
.star.on:hover {
  color: var(--text);
}

/*
 * 昵称独占一行，卡片头那一行只剩「属性」：状态点、来源标记、星标。
 *
 * 它原来挤在卡片头里、和「⚡ 自动读取」一样大（13px）—— 一屏十几张卡片扫过去，
 * 认不出哪张是哪张，只能去读命令行里的 `npm run xxx`，那恰恰是用户不想读的东西
 * （名字就是为了这个才存在的）。抽成独立一行并提到 15px 之后，整张卡片读起来是
 * 「属性 → 名字 → 实际跑的命令 → 状态 → 操作」，从上到下就是决策顺序。
 *
 * 长名字仍然省略号收尾，`title` 里带着全名 —— 单行是为了十几张卡片高度一致，
 * 参差的卡片高度会让扫视时的视线跳跃。
 */
.card-title {
  display: flex;
  min-width: 0;
}

.name {
  overflow: hidden;
  min-width: 0;
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.rename-input {
  min-width: 0;
  flex: 1;
  padding: 1px 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  outline: none;
}

.cmd {
  position: relative;
  overflow: hidden;
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--bg-input);
  cursor: copy;
}

/*
 * 「已复制」的即时反馈。
 *
 * 原先靠页脚那个复制按钮显示，按钮去掉后挪到命令行右端 —— 复制入口还在
 * （点命令行本身即可），没有反馈就变成了静默动作。
 */
.copied {
  position: absolute;
  inset: 0 0 0 auto;
  display: flex;
  align-items: center;
  padding: 0 8px;
  background: var(--bg-input);
  color: var(--ok);
  font-size: 11px;
}
.cmd code {
  display: block;
  overflow: hidden;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.pill.port {
  color: var(--accent);
  cursor: pointer;
}

.tag {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text-faint);
}
.tag.source {
  flex: none;
  white-space: nowrap;
}

.tag.warn {
  color: var(--warn);
}

.cwd {
  overflow: hidden;
  max-width: 130px;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.cwd.warn {
  color: var(--warn);
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn.sm {
  padding: 3px 8px;
  font-size: 12px;
}
</style>
