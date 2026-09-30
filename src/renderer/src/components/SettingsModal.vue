<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { collectCommands } from '@shared/tree'
import type { CommandNode, ThemeMode } from '@shared/types'
import { groupChainOf, openExternal, state, updateNode, updateSettings } from '../store/app'

const emit = defineEmits<{ close: [] }>()

/**
 * 主题只有三个值，全部摊开比藏进下拉框好 —— 一眼就能看出当前选的是哪个。
 *
 * 真正的换色动作在主进程（见 `src/main/theme.ts`）：那边改
 * `nativeTheme.themeSource`，渲染进程的 `prefers-color-scheme` 就跟着变，
 * `styles.css` 的媒体查询自动接住。这里只负责把选择交给 store。
 */
const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const form = reactive({
  theme: state.settings?.theme ?? 'dark',
  logBufferLines: state.settings?.logBufferLines ?? 5000,
  fontSize: state.settings?.fontSize ?? 12,
  launchDelayMs: state.settings?.launchDelayMs ?? 400,
  minimizeToTray: state.settings?.minimizeToTray ?? true,
  autoLaunch: state.settings?.autoLaunch ?? false,
  forceColor: state.settings?.forceColor ?? true,
  showHiddenCommands: state.settings?.showHiddenCommands ?? false,
})

const saving = ref(false)

async function save(): Promise<void> {
  saving.value = true
  try {
    await updateSettings({
      theme: form.theme,
      logBufferLines: Math.min(Math.max(Math.round(form.logBufferLines), 200), 100000),
      fontSize: Math.min(Math.max(Math.round(form.fontSize), 9), 22),
      launchDelayMs: Math.min(Math.max(Math.round(form.launchDelayMs), 0), 5000),
      minimizeToTray: form.minimizeToTray,
      autoLaunch: form.autoLaunch,
      forceColor: form.forceColor,
      showHiddenCommands: form.showHiddenCommands,
    })
    emit('close')
  } finally {
    saving.value = false
  }
}

function openConfigDir(): void {
  const dir = state.env?.userData
  if (dir) void openExternal(dir, 'path')
}

// ---------------------------------------------------------------------------
// 命令可见性
// ---------------------------------------------------------------------------
//
// 这一块是即时生效的，跟上面那些「保存」后才落盘的设置不一样：隐藏本身就是一个
// 开关动作，让用户先在表单里勾掉、还得记得按保存，太容易白干。这里的勾选框直接
// 写 store，关掉弹窗也是生效的。

const allCommands = computed(() => collectCommands(state.nodes, null, { includeHidden: true }))

/**
 * 命令可见性是**一个项目一份**的：一个项目的命令藏起来了，不该跟另一个项目的命令
 * 混在同一个列表里 —— 那样谁也说不清自己正在改的是哪一份。所以这里按**顶层分组**
 * 切成几段，一段就是一个项目。
 *
 * 判据用「命令的根级祖先分组」，不用「最近一个带 path 的祖先」：monorepo 那种
 * 子包被自动展开成分组的结构里，子包本身也带 path，按后者切会把同一个项目拆成好几段。
 */
interface VisSection {
  /** 顶层分组的 id；命令没有任何分组祖先时为 null（归到「（未分组）」段） */
  id: string | null
  name: string
  commands: CommandNode[]
  hidden: number
}

const visSections = computed<VisSection[]>(() => {
  const sections: VisSection[] = []
  const index = new Map<string, VisSection>()
  for (const command of allCommands.value) {
    const chain = groupChainOf(command.id)
    const root = chain.length ? chain[0] : undefined
    const key = root ? root.id : ''
    let section = index.get(key)
    if (!section) {
      section = { id: root ? root.id : null, name: root ? root.name : '（未分组）', commands: [], hidden: 0 }
      index.set(key, section)
      // 用 allCommands 的遍历顺序建段，段序就等于分组树里的先后顺序。
      sections.push(section)
    }
    section.commands.push(command)
    if (command.hidden) section.hidden += 1
  }
  return sections
})

/** 段内只画「这个项目之内」的那一段子分组路径，跟「编辑命令可见性」弹窗一个口径。 */
function subGroupOf(command: CommandNode, sectionId: string | null): string {
  const chain = groupChainOf(command.id)
  const rest = sectionId ? chain.slice(1) : chain
  return rest.map((group) => group.name).join(' / ')
}

function sectionStat(section: VisSection): string {
  const parts = [`${section.commands.length} 条命令`]
  if (section.hidden) parts.push(`${section.hidden} 隐藏`)
  return parts.join(' · ')
}

function setHidden(command: CommandNode, hidden: boolean): void {
  void updateNode({ id: command.id, hidden })
}

function onVisChange(command: CommandNode, event: Event): void {
  const target = event.target as HTMLInputElement
  setHidden(command, !target.checked)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" style="width: 560px">
      <div class="modal-head">设置</div>

      <div class="modal-body">
        <div class="field">
          <label>主题</label>
          <div class="seg">
            <button
              v-for="opt in THEME_OPTIONS"
              :key="opt.value"
              type="button"
              class="seg-btn"
              :class="{ on: form.theme === opt.value }"
              @click="form.theme = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <div class="hint">
            「跟随系统」会随 Windows 的浅色/深色设置一起切换，另两项固定不变。
            主题在这份表单里和日志行数一样，按保存后才生效。
          </div>
        </div>

        <div class="row">
          <div class="field" style="flex: 1">
            <label>每个项目保留的日志行数</label>
            <input v-model.number="form.logBufferLines" type="number" min="200" max="100000" />
            <div class="hint">超出部分从最早的行开始丢弃</div>
          </div>
          <div class="field" style="flex: 1">
            <label>日志字号 (px)</label>
            <input v-model.number="form.fontSize" type="number" min="9" max="22" />
          </div>
          <div class="field" style="flex: 1">
            <label>批量启动间隔 (ms)</label>
            <input v-model.number="form.launchDelayMs" type="number" min="0" max="5000" />
            <div class="hint">避免多个 Vite 同时冷启动抢 CPU</div>
          </div>
        </div>

        <label class="check">
          <input v-model="form.minimizeToTray" type="checkbox" />
          <span>点击关闭按钮时最小化到托盘，而不是退出</span>
        </label>

        <label class="check">
          <input v-model="form.autoLaunch" type="checkbox" />
          <span>开机自动启动本应用</span>
        </label>

        <label class="check">
          <input v-model="form.forceColor" type="checkbox" />
          <span>强制彩色输出（清掉 NO_COLOR，注入 FORCE_COLOR=1）</span>
        </label>

        <label class="check">
          <input v-model="form.showHiddenCommands" type="checkbox" />
          <span>在分组树里显示已隐藏的命令</span>
        </label>
        <div class="hint">
          隐藏的命令默认整条从树里消失。这个开关是兜底用的 ——
          万一你不小心把某条命令藏进了一个看不见的分组，还能在这里把它捞出来。
        </div>

        <div class="field">
          <label>命令可见性</label>
          <p v-if="visSections.length === 0" class="hint">还没有任何命令。</p>
          <div v-else class="vis-sections">
            <section v-for="section in visSections" :key="section.id ?? '__root__'" class="vis-section">
              <div class="vis-head">
                <span class="vis-project">{{ section.name }}</span>
                <span class="vis-stat">{{ sectionStat(section) }}</span>
              </div>
              <div class="vis-list">
                <label v-for="cmd in section.commands" :key="cmd.id" class="vis-row">
                  <input type="checkbox" :checked="!cmd.hidden" @change="onVisChange(cmd, $event)" />
                  <span class="vis-name" :class="{ off: cmd.hidden }">{{ cmd.name }}</span>
                  <span class="vis-group">{{ subGroupOf(cmd, section.id) }}</span>
                </label>
              </div>
            </section>
          </div>
          <div class="hint">
            取消勾选 = 隐藏。隐藏只是从树和卡片区拿掉，配置本身照常保留、随时能勾回来。
            这一块改动<b>立即生效</b>，不用按保存。
          </div>
        </div>

        <div v-if="state.env?.noColorInEnv && form.forceColor" class="hint">
          检测到本机环境变量里设置了 <code>NO_COLOR</code>。开启此项会覆盖它，
          并在日志开头产生一条 Node 警告。若你本来就有意关闭颜色，请取消勾选。
        </div>

        <div class="field">
          <label>运行环境</label>
          <div class="kv">
            <span class="k">Electron</span><span class="v">{{ state.env?.electron ?? '-' }}</span>
            <span class="k">Node</span><span class="v">{{ state.env?.node ?? '-' }}</span>
            <span class="k">平台</span><span class="v">{{ state.env?.platform ?? '-' }}</span>
            <span class="k">配置目录</span><span class="v">{{ state.env?.userData ?? '-' }}</span>
          </div>
          <div class="row" style="margin-top: 6px">
            <button class="btn" @click="openConfigDir">打开配置目录</button>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <div class="spacer" />
        <button class="btn" :disabled="saving" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="saving" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.seg-btn {
  padding: 4px 14px;
  font-size: 12px;
  font-family: inherit;
  background: var(--bg-input);
  color: var(--text-dim);
  border: none;
  border-right: 1px solid var(--border);
  cursor: pointer;
}

.seg-btn:last-child {
  border-right: none;
}

.seg-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.seg-btn.on {
  background: var(--accent);
  color: #fff;
}

/* .vis-list / .vis-row / .vis-name / .vis-group 已挪到 styles.css：这个弹窗和
   「编辑命令可见性」弹窗渲染同一种列表，样式在全局只有一份。 */

/* 下面这些只是「按项目分段」的外壳，只有设置弹窗用，所以留在 scoped 里。 */

.vis-section + .vis-section {
  margin-top: 10px;
}

.vis-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
}

.vis-project {
  overflow: hidden;
  min-width: 0;
  flex: 1;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vis-stat {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
}

/* 分段之后每一段都是一个小盒子，再各自带 260px 的滚动条就成了「滚动套滚动」，
   难受且没必要 —— 外层 .modal-body 本来就能滚，这里放开让整段自然撑开。 */
.vis-sections .vis-list {
  max-height: none;
  overflow-y: visible;
}
</style>
