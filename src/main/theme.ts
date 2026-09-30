import { BrowserWindow, nativeTheme } from 'electron'
import type { ThemeMode } from '@shared/types'

/**
 * 主题的唯一落地点在主进程。
 *
 * 这里把用户选的 `dark | light | system` 原样交给 Chromium
 * （`nativeTheme.themeSource`），渲染进程的 `prefers-color-scheme`
 * 就会跟着改变，`styles.css` 用媒体查询接住即可。
 *
 * 于是渲染层一行主题代码都不需要：改设置 → 改 themeSource →
 * 媒体查询重新求值 → 界面立刻换色。不用往 DOM 上挂 `data-theme`、
 * 不用在 Vue 里同步一份状态，也不存在「首帧还不知道主题所以先闪一下」。
 */

/**
 * 窗口底色。
 *
 * 必须与 `styles.css` 里 `--bg` 的两个取值保持一致 —— 窗口的
 * `backgroundColor` 只在「页面还没画出来」和「缩放/拖动时的空隙」露出来，
 * 但恰恰是这些时刻最显眼，不一致就会闪一下另一种颜色（深色主题下是刺眼的白）。
 */
const BG_DARK = '#101014'
const BG_LIGHT = '#f4f5f7'

/** 把用户的主题选择告诉 Chromium；'system' 表示继续跟随操作系统 */
export function applyThemeSource(theme: ThemeMode): void {
  nativeTheme.themeSource = theme
}

/** 当前实际生效的窗口底色 */
export function currentBackground(): string {
  return nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT
}

/**
 * 把当前底色同步到所有已存在的窗口。
 *
 * 不更新的话，从深色切到浅色会留下一圈深色边框 —— 那条边框正是
 * 窗口底色在页面内容之外露出来的部分。
 */
export function refreshWindowBackgrounds(): void {
  const color = currentBackground()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(color)
  }
}
