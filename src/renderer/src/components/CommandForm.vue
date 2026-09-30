<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ancestorChain, resolvePath } from '@shared/tree'
import type { CommandNode, PackageInfo, ShellKind } from '@shared/types'
import { createCommand, state, updateNode } from '../store/app'

const props = defineProps<{
  /** 编辑模式传入被编辑的命令；新建模式传 null/不传 */
  node?: CommandNode | null
  /** 新建模式：命令挂在哪个分组下 */
  parentId?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const editing = computed(() => Boolean(props.node))

const name = ref(props.node?.name ?? '')
const command = ref(props.node?.command ?? '')
const script = ref<string | null>(props.node?.script ?? null)
const shell = ref<ShellKind>(props.node?.shell ?? 'cmd')
const marked = ref(props.node?.marked ?? false)
const customPort = ref(props.node?.expectedPort ? String(props.node.expectedPort) : '')
const error = ref<string | null>(null)
const saving = ref(false)

// ---------------------------------------------------------------------------
// 工作目录：只读，从祖先分组继承
// ---------------------------------------------------------------------------
//
// 命令节点自身不存路径 —— 它跑在「最近的带 path 的祖先分组」的目录里。
// 弹窗里把这个继承结果显式展示出来，用户才知道这条命令到底在哪儿跑。

const parentId = computed(() => props.node?.parentId ?? props.parentId ?? null)

const dir = computed(() => {
  const id = parentId.value
  return id ? (resolvePath(state.nodes, id) ?? null) : null
})

/**
 * 继承来的目录归属于哪个分组（可能不是直接父分组）。
 *
 * 按「最近一个带 path 的祖先」找，而不是拿 `node.path === target` 做字符串比较：
 * monorepo 下同一个目录被两个分组同时绑定是常见情况，字符串比较会停在靠根的
 * 那一个上，于是弹窗显示的「继承自 xxx」是错的。这里的判定与 resolvePath
 * 用的是同一套规则，所以显示的归属与实际生效的目录必然一致。
 */
const dirOwner = computed(() => {
  const id = parentId.value
  if (!id || !dir.value) return null
  const chain = ancestorChain(state.nodes, id)
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i]
    if (node && node.kind === 'group' && node.path && node.path.trim()) return node
  }
  return null
})

// ---------------------------------------------------------------------------
// 从 package.json 挑一条 script
// ---------------------------------------------------------------------------

const info = ref<PackageInfo | null>(null)
const loadingPkg = ref(false)

onMounted(async () => {
  const target = dir.value
  if (!target) return
  loadingPkg.value = true
  try {
    const result = await window.api.pkg.inspect(target)
    info.value = result.found ? result : null
  } catch {
    info.value = null
  } finally {
    loadingPkg.value = false
  }
})

/** 与 src/main/core/PackageReader.ts 里的 scriptToCommand 同规则 */
function scriptCommand(key: string): string {
  return `${info.value?.packageManager ?? 'npm'} run ${key}`
}

function pickScript(key: string): void {
  if (!key) return
  script.value = key
  command.value = scriptCommand(key)
  if (!name.value.trim()) name.value = key
}

/** 手改命令之后就撤销「· script」这个来源标记，免得标记开始说谎 */
function onCommandInput(): void {
  if (!script.value || !info.value) return
  if (command.value.trim() !== scriptCommand(script.value)) script.value = null
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

const fallbackName = computed(() => {
  const typed = name.value.trim()
  if (typed) return typed
  if (script.value) return script.value
  return command.value.trim().slice(0, 20)
})

async function submit(): Promise<void> {
  error.value = null

  const cmd = command.value.trim()
  if (!cmd) {
    error.value = '命令不能为空'
    return
  }

  let port: number | undefined
  const rawPort = customPort.value.trim()
  if (rawPort) {
    const parsed = Number(rawPort)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      error.value = '预期端口得是 1–65535 之间的整数'
      return
    }
    port = parsed
  }

  saving.value = true
  try {
    if (props.node) {
      await updateNode({
        id: props.node.id,
        name: fallbackName.value,
        command: cmd,
        shell: shell.value,
        marked: marked.value,
        expectedPort: port,
      })
    } else {
      if (!parentId.value) {
        error.value = '先选中一个分组，命令需要一个工作目录'
        return
      }
      if (!dir.value) {
        error.value = '这个分组（以及它的上级）都没有绑定项目目录，命令会跑不起来'
        return
      }
      await createCommand({
        parentId: parentId.value,
        name: fallbackName.value,
        command: cmd,
        script: script.value ?? undefined,
        shell: shell.value,
        marked: marked.value,
        expectedPort: port,
      })
    }
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dlg-head">
        <h2>{{ editing ? '编辑命令' : '新建命令' }}</h2>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="dlg-body">
        <label class="field">
          <span class="label">名称</span>
          <input v-model="name" class="input" :placeholder="fallbackName || '跑起来看看'" />
          <span class="hint">留空的话，依次取 script 名、命令行前 20 个字</span>
        </label>

        <label class="field">
          <span class="label">命令</span>
          <input
            v-model="command"
            class="input mono"
            placeholder="npm run dev"
            @input="onCommandInput"
          />
        </label>

        <label v-if="info && info.scripts.length" class="field">
          <span class="label">从 package.json 挑</span>
          <select class="input" :value="script ?? ''" @change="pickScript(($event.target as HTMLSelectElement).value)">
            <option value="">— 不挑，手动输入 —</option>
            <option v-for="item in info.scripts" :key="item.key" :value="item.key">
              {{ item.key }} — {{ item.value }}
            </option>
          </select>
        </label>
        <p v-else-if="loadingPkg" class="hint line">正在读 package.json…</p>
        <p v-else-if="!dir" class="hint line warn">
          所属分组没有绑定项目目录，这条命令没有工作目录可用
        </p>

        <div class="field">
          <span class="label">工作目录</span>
          <div class="readonly" :class="{ warn: !dir }">
            {{ dir ?? '未绑定 —— 请先给某个分组绑定项目目录' }}
          </div>
          <span v-if="dirOwner" class="hint">继承自分组「{{ dirOwner.name }}」</span>
        </div>

        <div class="grid2">
          <label class="field">
            <span class="label">预期端口</span>
            <input v-model="customPort" class="input" placeholder="5173" inputmode="numeric" />
            <span class="hint">可空，只用来在启动前提醒你</span>
          </label>

          <label class="field">
            <span class="label">Shell</span>
            <select v-model="shell" class="input">
              <option value="cmd">cmd</option>
              <option value="powershell">powershell</option>
            </select>
          </label>
        </div>

        <label class="check">
          <input v-model="marked" type="checkbox" />
          <span>标记为常驻命令 —— 点「启动已标记」时会一起启动</span>
        </label>

        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <footer class="dlg-foot">
        <div class="spacer" />
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn" :disabled="saving" @click="submit">
          {{ editing ? '保存' : '创建' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  inset: 0;
  background: var(--overlay);
}

.dialog {
  display: flex;
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 80px);
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-modal);
}

.dlg-head {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.dlg-head h2 {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.x {
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.x:hover {
  color: var(--text);
}

.dlg-body {
  display: flex;
  overflow: auto;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  color: var(--text-dim);
  font-size: 12px;
}

.input {
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.input:focus {
  border-color: var(--accent);
}
.input.mono {
  font-family: var(--mono);
}

.readonly {
  overflow: hidden;
  padding: 6px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.readonly.warn {
  color: var(--warn);
}

.hint {
  color: var(--text-faint);
  font-size: 11px;
}
.hint.line {
  margin: 0;
}
.hint.warn {
  color: var(--warn);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
}

.err {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.dlg-foot {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}
</style>
