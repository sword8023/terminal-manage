<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PackageInfo } from '@shared/types'
import { createGroup, groupOptions, importDir } from '../store/app'
import type { GroupOption } from '../store/app'

/**
 * 新建一个节点 —— 「项目」或「分组」。
 *
 * 两者只差一件事：**项目必须绑一个项目目录**，分组只是分类用的名字。
 *
 * 早先这两个入口共用一个「目录可留空」的弹窗，标题还是靠「用户有没有填目录」
 * 反推出来的，于是点了「＋目录」看到的却是「新建分组」，名字与路径都像可选。
 * 现在模式由调用方显式传入，标题 / 字段 / 校验 / 按钮文案全部跟着模式走。
 *
 * 没有拆成两个组件：弹窗外壳、pickDir 与 inspect 的预览、校验与报错是同一套，
 * 拆开只会把这一百多行样式和管道复制两份。
 *
 * 「所属分组」下拉框是后加的：父级原先完全由入口决定（点树上头的「＋项目」就是
 * 根级，右键某个分组才有子级），而这个区别只写在右键菜单里 —— 想建到某个分组下
 * 就得先猜到要右键。现在把父级摊到弹窗里明说，`parentId` 退回成**默认值**。
 */
const props = defineProps<{
  /** 新节点默认建在哪个分组下（用户可以在弹窗里改）；null = 根级 */
  parentId: string | null
  /** project = 项目（名称 + 路径都必填）；group = 纯分类分组（只要名称） */
  mode: 'project' | 'group'
}>()

const emit = defineEmits<{ close: [] }>()

const isProject = computed(() => props.mode === 'project')

// 空串代表根级。用空串而不是 null 是为了让 v-model 老老实实接字符串，不必依赖
// Vue 给 <option :value="null"> 塞进 _value 的那套内部机制；节点 id 是 uuid，
// 空串撞不上真 id。
const parent = ref<string>(props.parentId ?? '')
const dir = ref('')
const name = ref('')
const expandWorkspaces = ref(true)
const importScripts = ref(true)
const error = ref<string | null>(null)
const saving = ref(false)
const preview = ref<PackageInfo | null>(null)
const inspecting = ref(false)

/** 路径的最后一段，package.json 没有 name 时拿它兜底 */
const dirBaseName = computed(() => {
  if (!dir.value) return ''
  const parts = dir.value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
})

const namePlaceholder = computed(
  () =>
    preview.value?.name ||
    dirBaseName.value ||
    (isProject.value ? '例如：后台管理' : '例如：前端项目'),
)

/** 读目录的 package.json，顺带把包名填进名称 */
async function inspect(target: string): Promise<void> {
  if (!target) {
    preview.value = null
    return
  }
  inspecting.value = true
  try {
    preview.value = await window.api.pkg.inspect(target)
  } catch {
    preview.value = null
  } finally {
    inspecting.value = false
  }
  // 只在用户还没自己写过名称时填。
  //
  // 填的是真名（package.json 的 name）而不是一个悄悄生效的替身：用户看得见、
  // 改得动，所以「项目必须有名称」这条要求没有被绕过，只是省了一次输入。
  if (!name.value.trim()) {
    const suggested = preview.value?.name || dirBaseName.value
    if (suggested) name.value = suggested
  }
}

async function chooseDir(): Promise<void> {
  const picked = await window.api.shell.pickDir()
  if (!picked) return
  dir.value = picked
  error.value = null
  await inspect(picked)
}

/** 手改路径时先把旧预览作废，等失焦再重新读 */
function onDirInput(): void {
  preview.value = null
  error.value = null
}

async function onDirBlur(): Promise<void> {
  if (!preview.value) await inspect(dir.value.trim())
}

/** 下拉项按层级缩进 —— 全角空格在原生 select 里不会被折叠掉 */
function optionLabel(opt: GroupOption): string {
  return '　'.repeat(opt.depth) + opt.name
}

/** 选中的父级；空串落回 null（根级） */
function targetParent(): string | null {
  return parent.value || null
}

async function submit(): Promise<void> {
  error.value = null

  const finalName = name.value.trim()
  if (!finalName) {
    error.value = isProject.value ? '请填项目名称' : '请填分组名称'
    return
  }
  if (isProject.value && !dir.value.trim()) {
    error.value = '请选择项目路径'
    return
  }

  saving.value = true
  try {
    if (!isProject.value) {
      // 纯分类分组 —— 没有绑目录，但一样可以往下再建子分组
      await createGroup(targetParent(), finalName)
      emit('close')
      return
    }

    const result = await importDir({
      parentId: targetParent(),
      dir: dir.value.trim(),
      name: finalName,
      expandWorkspaces: expandWorkspaces.value,
      importScripts: importScripts.value,
    })
    if (!result) return
    // warnings 不能当失败处理：走到这里分组和命令已经建好了。
    // 之前在这里 return 不关弹窗，用户看到红字以为失败、再点一次「导入」，
    // 结果是在同名分组下又建了一整套。warnings 现在由 store 的 notice 提示条
    // 在关闭弹窗之后呈现。
    emit('close')
  } finally {
    saving.value = false
  }
}

const summary = computed(() => {
  const info = preview.value
  if (!info) return ''
  const bits = [`包管理器 ${info.packageManager}`]
  if (info.scripts.length) bits.push(`${info.scripts.length} 个 script`)
  if (info.workspaces.length) bits.push(`${info.workspaces.length} 个 workspace`)
  return bits.join(' · ')
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dlg-head">
        <h2>{{ isProject ? '新建项目' : '新建分组' }}</h2>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="dlg-body">
        <label class="field">
          <span class="label">所属分组</span>
          <select v-model="parent" class="input">
            <option value="">根级（最外层）</option>
            <option v-for="opt in groupOptions" :key="opt.id" :value="opt.id">
              {{ optionLabel(opt) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="label">{{ isProject ? '项目名称' : '分组名称' }}</span>
          <input v-model="name" class="input" :placeholder="namePlaceholder" />
        </label>

        <template v-if="isProject">
          <div class="field">
            <span class="label">项目路径</span>
            <div class="row">
              <input
                v-model="dir"
                class="input mono flex"
                placeholder="D:\projects\my-app"
                @input="onDirInput"
                @blur="onDirBlur"
              />
              <button class="btn ghost" @click="chooseDir">选择…</button>
            </div>
          </div>

          <p v-if="inspecting" class="hint">正在读 package.json…</p>
          <p v-else-if="dir && preview && !preview.found" class="hint warn">
            这个目录里没有 package.json —— 项目照样能建，但读不出命令
          </p>
          <p v-else-if="dir && summary" class="hint ok">{{ summary }}</p>

          <label class="check">
            <input v-model="importScripts" type="checkbox" />
            <span>自动把 package.json 里的 scripts 建成命令卡片</span>
          </label>
          <label class="check">
            <input v-model="expandWorkspaces" type="checkbox" />
            <span>展开 monorepo 的子包，每个子包一个分组</span>
          </label>

          <p class="hint">
            导入出来的卡片带「⚡ 自动读取」标记，以后重新扫描会跟着 package.json 一起变；
            你手动新建的卡片不会被扫描改动。
          </p>
        </template>

        <p v-else class="hint">
          分组只是给命令分个类，不需要目录。建好之后可以在它下面继续建子分组，
          也可以右键分组选「绑定项目目录…」，让它下面的命令有地方可跑。
        </p>

        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <footer class="dlg-foot">
        <div class="spacer" />
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn" :disabled="saving" @click="submit">
          {{ isProject ? '创建项目' : '创建分组' }}
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
  width: 520px;
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

.row {
  display: flex;
  gap: 6px;
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

/* 全局给 select 定了 height:30px + padding:0 9px，而上面 .input 的内边距是给
   输入框用的 6px 8px。不覆盖的话下拉框会和它上面的输入框对不齐。 */
select.input {
  height: 30px;
  padding: 0 8px;
  cursor: pointer;
}
.input.mono {
  font-family: var(--mono);
  font-size: 12px;
}
.flex {
  min-width: 0;
  flex: 1;
}

.hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}
.hint.warn {
  color: var(--warn);
}
.hint.ok {
  color: var(--ok);
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
