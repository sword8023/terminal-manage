<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatBytes } from '../utils/bytes'
import {
  cancelUpdate,
  checkUpdate,
  downloadUpdate,
  installUpdate,
  revealUpdate,
  runningCount,
  state,
} from '../store/app'

const emit = defineEmits<{ close: [] }>()

/**
 * 升级界面。
 *
 * 界面侧对升级只有一个责任：把主进程那份状态说清楚。所有判断（有没有新版本、
 * 失败原因、包校验过没有）都在主进程的 Updater 里做完，这里只翻译成一句话 ——
 * 两边各判一次，迟早会出现「界面说有新版、主进程其实早报错了」。
 */

const update = computed(() => state.update)
const phase = computed(() => state.update?.phase ?? 'idle')

const available = computed(() => phase.value === 'available')
const downloading = computed(() => phase.value === 'downloading')
const ready = computed(() => phase.value === 'ready')
const installing = computed(() => phase.value === 'installing')
const failed = computed(() => phase.value === 'error')

/**
 * 进度百分比；主进程给 null 表示服务端没报 content-length，那就不确定态。
 *
 * 不确定态下显示一个编出来的百分比是本仓库最不想做的事：进度条走到 90% 停住的
 * 那种「看起来快好了」比诚实地来回滚动要不友好得多。
 */
const progressPercent = computed<number | null>(() => {
  const progress = state.update?.progress
  if (progress === undefined || progress === null) return null
  return Math.round(progress * 100)
})

/** 下载按钮上顺带把包大小说清楚：106 MB 在慢网上下要几分钟，用户有权先知道 */
const sizeText = computed(() => {
  const size = state.update?.info?.asset.size
  if (!size) return ''
  const text = formatBytes(size)
  return text ? `（${text}）` : ''
})

const speedText = computed(() => {
  const speed = state.update?.bytesPerSecond
  return speed ? `${formatBytes(speed)}/s` : ''
})

/** 更新说明。**必须是纯文本**，它来自网络，落进 v-html 就等于把更新源当代码执行 */
const notes = computed(() => state.update?.info?.notes ?? '')

const version = computed(() => update.value?.info?.version ?? '')
const current = computed(() => update.value?.current ?? '')

const updateHint = computed(() => {
  const info = update.value
  if (!info) return '还没有检查过。'
  switch (info.phase) {
    case 'unsupported':
      return '当前平台不支持自动更新。'
    case 'checking':
      return '正在检查…'
    case 'up-to-date':
      return `已是最新版本（${info.current}）。`
    case 'available':
      return info.info?.required
        ? `这个版本必须升级：${version.value}（当前 ${info.current}）`
        : `发现新版本 ${version.value}（当前 ${info.current}）`
    case 'downloading':
      return `正在下载新版本 ${version.value}…`
    case 'ready':
      return `新版本 ${version.value} 已下载完成，可以安装了。`
    case 'installing':
      return '正在安装新版本…'
    case 'error':
      // 「更新失败」而不是「检查失败」：这里的 error 可能来自检查，也可能来自下载
      return `更新失败：${info.error ?? '未知原因'}`
  }
})

/**
 * 「升级后是否拉起已标记的命令」。
 *
 * **默认必须是关的**：打开这个工具通常只是想看一眼日志或改个配置，升级重启后再被一堆
 * dev server 抢占端口和 CPU，正是本工具当初特意放弃的坏默认（见 docs/升级模块方案.md §7）。
 */
const restartMarked = ref(false)

const runningText = computed(() => {
  const count = runningCount.value
  if (count === 0) return '当前没有命令在运行。'
  return `当前有 ${count} 条命令在运行，安装会先停止它们。`
})

/**
 * 出错时的重试动作。
 *
 * 分成两种，因为两种失败的补救方式完全不同：`info` 还在说明新版本是认到了的，
 * 只是包没下来 —— 重试就是接着下载；`info` 没了说明这次检查本身就没成功，
 * 那要重试的是检查。
 */
async function retry(): Promise<void> {
  if (state.update?.info) await downloadUpdate()
  else await checkUpdate()
}

/**
 * 打开时若还没检查过就自动查一次。
 *
 * 只在 idle 时查：已经拿到结果（比如刚从托盘点开、主进程十秒前刚自动查过）时再查一次，
 * 会让用户看到一个刚亮起来的结果又被「正在检查…」盖掉。
 */
onMounted(() => {
  if (phase.value === 'idle') void checkUpdate()
})
</script>

<template>
  <div class="overlay" @click.self="installing ? undefined : emit('close')">
    <div class="modal" style="width: 520px">
      <div class="modal-head">升级</div>

      <div class="modal-body">
        <p class="status" :class="{ bad: failed }">{{ updateHint }}</p>

        <div v-if="downloading" class="progress">
          <div
            class="progress-bar"
            :class="{ unknown: progressPercent === null }"
            :style="progressPercent === null ? undefined : { width: `${progressPercent}%` }"
          />
        </div>
        <div v-if="downloading" class="hint">
          <template v-if="progressPercent === null">已下载的数据量未知（服务端没报长度）</template>
          <template v-else>{{ progressPercent }}%</template>
          <template v-if="speedText"> · {{ speedText }}</template>
        </div>

        <p v-if="notes" class="notes">{{ notes }}</p>

        <template v-if="ready">
          <div class="hint">{{ runningText }}</div>
          <label class="check">
            <input v-model="restartMarked" type="checkbox" />
            <span>升级重启后自动启动已标记的命令</span>
          </label>
          <div class="hint">
            默认不勾：升级会关掉本应用，重启后自己拉起的命令往往比你想要的更多。
            勾上只影响这一次升级 —— 这个意图用完即删，不会变成长期设置。
          </div>
        </template>

        <div v-if="installing" class="hint">
          应用即将关闭，安装完成后会自动重新打开。请不要手动结束进程。
        </div>

        <div class="hint">当前版本 {{ current }}</div>
      </div>

      <div class="modal-foot">
        <button v-if="phase === 'up-to-date'" class="btn" @click="checkUpdate">重新检查</button>
        <button v-if="failed" class="btn primary" @click="retry">重试</button>
        <button v-if="available" class="btn primary" @click="downloadUpdate">
          下载新版本{{ sizeText }}
        </button>
        <button v-if="downloading" class="btn" @click="cancelUpdate">取消下载</button>
        <button v-if="ready" class="btn" @click="revealUpdate">打开所在文件夹</button>

        <div class="spacer" />

        <button v-if="installing" class="btn" disabled>正在安装…</button>
        <button v-else-if="ready" class="btn primary" @click="installUpdate(restartMarked)">
          立即重启并安装
        </button>
        <button v-else class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status {
  margin: 0;
  font-size: 13px;
}

.status.bad {
  color: var(--danger, #e5534b);
}

/* 更新说明来自网络，用 pre-wrap 保留换行即可 —— 不解析成 HTML */
.notes {
  overflow-y: auto;
  max-height: 180px;
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

/* 下载进度条。全局样式里没有现成的（界面此前没有任何进度显示），按区块惯例留在 scoped 里。 */
.progress {
  overflow: hidden;
  height: 6px;
  margin-top: 10px;
  border-radius: 3px;
  background: var(--bg-input);
}

.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.2s linear;
}

/* 服务端没有报 content-length 时百分比是编的：改成缓慢来回的高亮条，
   表示「在动，但不知道还剩多久」。 */
.progress-bar.unknown {
  width: 30%;
  animation: progress-unknown 1.2s ease-in-out infinite alternate;
}

@keyframes progress-unknown {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
</style>
