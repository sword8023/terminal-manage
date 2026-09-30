import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * 必须在 electron-vite 启动 Electron 之前清掉这个变量。
 *
 * ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node 进程：不加载
 * Chromium、不创建 app，`require('electron')` 返回的是可执行文件路径字符串
 * 而不是模块。症状是主进程一启动就抛
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 * 却完全看不出是环境变量在作祟（因为 electron.exe 确实被执行了）。
 *
 * 这个变量常被 IDE、CI 和调试宿主注入，属于「换个机器就复现不了」的那类坑，
 * 所以在配置文件里无条件兜底，而不是要求用户记得先 unset。
 */
delete process.env.ELECTRON_RUN_AS_NODE

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    /**
     * 渲染进程的 dev server 默认端口也是 5173 —— 而那正是绝大多数 Vue 项目
     * 的默认端口。用这个工具去开发 Vue 项目，结果工具自己先占住 5173，
     * 逼用户的项目被 Vite 自动 +1 到 5174，是件很荒谬的事。
     * 挪到一个 Vite 默认值不会命中的端口，这样「工具」和「被管理的项目」
     * 在任何情况下都不会互相抢端口。
     *
     * strictPort：宁可启动失败也不要静默换端口 —— 静默换端口正是本项目
     * 要解决的问题（僵尸 dev server 占着 5174/5175 越堆越多）。
     */
    server: { port: 5273, strictPort: true },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared,
      },
    },
    plugins: [vue()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
