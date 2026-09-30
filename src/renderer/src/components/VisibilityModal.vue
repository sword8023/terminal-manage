<script setup lang="ts">
import { computed } from 'vue'
import { collectCommands } from '@shared/tree'
import type { CommandNode } from '@shared/types'
import { groupChainOf, state, updateNode } from '../store/app'

/**
 * 「编辑命令可见性」弹窗。
 *
 * 作用范围由打开它的入口决定：项目/分组的右键菜单传那一层的 id，卡片区标题行
 * 传当前选中的分组（null = 全部）。范围不是装饰 —— 这里列出的就是卡片区正在
 * 显示的那批命令，用户不用猜「我这一下改的是哪些」。
 *
 * 勾选语义是「勾上 = 显示」。反过来（勾上 = 隐藏）在命令多的时候更省事，但
 * 「勾掉一条」和「它会消失」方向相反，勾错之后看到的是自己刚想留下的那条不见
 * 了；顺着动作的方向写，勾错了也看得出来。
 */
const props = defineProps<{ rootId: string | null; rootLabel: string }>()
const emit = defineEmits<{ close: [] }>()

/** 含已隐藏的：这个弹窗的职责就是让隐藏过的还能被捞回来 */
const commands = computed(() =>
  collectCommands(state.nodes, props.rootId, { includeHidden: true }),
)

const hiddenCount = computed(() => commands.value.filter((cmd) => cmd.hidden).length)

/**
 * 行尾的分组提示，只画**范围之内**的那一段。
 *
 * 把它写成「相对当前范围」而不是「完整路径」：范围是 my-app 时，
 * 每行都重复一遍 my-app 是纯噪音；但 monorepo 里 packages/web 与
 * packages/admin 的区别必须留下 —— 那正是两条同名 dev 命令的唯一区别。
 */
function relGroupOf(command: CommandNode): string {
  const chain = groupChainOf(command.id)
  const rootAt = props.rootId ? chain.findIndex((group) => group.id === props.rootId) : -1
  const rest = rootAt >= 0 ? chain.slice(rootAt + 1) : chain
  if (rest.length === 0) return props.rootId ? '' : '（根级）'
  return rest.map((group) => group.name).join(' / ')
}

/** 隐藏是可逆的开关，直接写 store —— 跟设置弹窗里那块一样，不等「保存」。 */
function onToggle(command: CommandNode, event: Event): void {
  const target = event.target as HTMLInputElement
  void updateNode({ id: command.id, hidden: !target.checked })
}

function setAllHidden(hidden: boolean): void {
  for (const command of commands.value) {
    if (command.hidden !== hidden) void updateNode({ id: command.id, hidden })
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" style="width: 560px">
      <div class="modal-head">编辑命令可见性 · {{ props.rootLabel }}</div>

      <div class="modal-body">
        <div class="row">
          <span class="legend">勾上 = 显示，取消勾选 = 隐藏。改动立即生效，不用保存。</span>
          <div class="spacer" />
          <button class="btn ghost" :disabled="commands.length === 0" @click="setAllHidden(false)">
            全部显示
          </button>
          <button class="btn ghost" :disabled="commands.length === 0" @click="setAllHidden(true)">
            全部隐藏
          </button>
        </div>

        <div v-if="commands.length === 0" class="legend">
          这个范围里还没有命令。先在卡片区新建一条，或右键项目「重新扫描 package.json」。
        </div>
        <div v-else class="vis-list">
          <label v-for="command in commands" :key="command.id" class="vis-row">
            <input type="checkbox" :checked="!command.hidden" @change="onToggle(command, $event)" />
            <span class="vis-name" :class="{ off: command.hidden }">{{ command.name }}</span>
            <span v-if="command.missing" class="gone" title="package.json 里已经没有这个 script 了">
              已失效
            </span>
            <span class="vis-group">{{ relGroupOf(command) }}</span>
          </label>
        </div>

        <div class="legend">
          隐藏只是把它从分组树和卡片区拿掉 —— 命令本身、脚本绑定和日志都原样保留，随时能
          勾回来；隐藏的命令也照样会被「启动已标记」带起来。共 {{ commands.length }} 条，当前隐藏
          {{ hiddenCount }} 条。
        </div>
      </div>

      <div class="modal-foot">
        <div class="spacer" />
        <button class="btn primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.legend {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}

.gone {
  flex: none;
  color: var(--warn);
  font-size: 11px;
}
</style>
