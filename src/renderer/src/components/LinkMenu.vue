<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { LINKS_MAX, openExternal } from '../store/app'

/**
 * 卡片上的「链接」下拉 —— 列出这条命令输出里出现过的地址，点一条交给系统浏览器。
 *
 * 与 NodeMenu 共用一套外壳（Teleport 到 body、按视口夹取坐标、Esc 关闭），
 * 但语义完全不同：它只做一件事，所以项高、宽度、标题都是为「长 URL」调过的。
 *
 * 为什么要这个下拉：dev server 的地址只在一屏出现一次，之后被大量输出顶走，
 * 而日志面板头部的入口只能给「最近一个」。一条命令同时暴露多个地址时
 * （前端 + mock 服务、多个子包各自的端口），得能挑。
 */
const props = defineProps<{ urls: string[]; x: number; y: number }>()

const emit = defineEmits<{ close: [] }>()

function close(): void {
  emit('close')
}

function pick(url: string): void {
  close()
  void openExternal(url, 'url')
}

/** 省掉协议与尾斜杠，好让长地址的尾巴（端口、路径）留在可见范围内 */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

// 菜单比 NodeMenu 宽（要放 URL），夹取时按自己的宽度算
const pos = computed(() => ({
  left: `${Math.min(props.x, Math.max(8, window.innerWidth - 340))}px`,
  top: `${Math.min(props.y, Math.max(8, window.innerHeight - 280))}px`,
}))

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
      <div class="menu-title">在浏览器中打开</div>
      <div class="menu-scroll">
        <button
          v-for="url in props.urls"
          :key="url"
          class="menu-item"
          :title="url"
          @click="pick(url)"
        >
          <span class="url">{{ shortUrl(url) }}</span>
          <span class="go">↗</span>
        </button>
      </div>
      <div v-if="props.urls.length >= LINKS_MAX" class="menu-note">
        只列出最近 {{ LINKS_MAX }} 个
      </div>
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
  width: 320px;
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
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--link);
  cursor: pointer;
  text-align: left;
}
.menu-item:hover {
  background: var(--bg-input);
}

.url {
  overflow: hidden;
  flex: 1;
  font-family: var(--mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.go {
  flex: none;
  color: var(--text-faint);
  font-size: 12px;
}
.menu-item:hover .go {
  color: var(--link);
}

.menu-note {
  padding: 6px 10px;
  color: var(--text-faint);
  font-size: 11px;
}
</style>
