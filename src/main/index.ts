import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import type { NativeImage } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { ConfigStore } from './store/config'
import { ProcessManager } from './core/ProcessManager'
import { collectMarkedSpecs, registerIpc } from './ipc'
import { applyThemeSource, currentBackground } from './theme'

const isDev = !app.isPackaged
/** electron-vite 在 dev 模式下注入的渲染进程地址 */
const rendererUrl = process.env['ELECTRON_RENDERER_URL']

/**
 * 排查「窗口不出来」的出口。
 *
 * Electron 里渲染进程加载失败是**完全静默**的：窗口停在 `show: false` 后面
 * 永远不显示，用户看到的只是一个「没反应但也没崩」的进程；而且 Windows 上
 * GUI 进程的 stdout 未必连得到父终端，`console.log` 可能一个字都看不到。
 * 实际就被这个坑卡住过 —— 现象是 4 个 electron 进程都在、CPU 也不高、
 * 就是没有窗口，没有任何错误信息。
 *
 * 因此设 `TM_DEBUG=1` 时把窗口生命周期事件落到 userData/debug.log。
 * 用文件而不是 stderr，是因为文件写入一定会成功。
 */
const debugLog = process.env['TM_DEBUG']
  ? (msg: string): void => {
      try {
        appendFileSync(join(app.getPath('userData'), 'debug.log'), `${new Date().toISOString()} ${msg}\n`)
      } catch {
        // 诊断本身绝不能影响主流程
      }
    }
  : null

/**
 * `TM_DEBUG=1` 时额外打开 Chrome DevTools Protocol 端口，让界面可以被脚本驱动。
 *
 * 为什么需要：渲染层的 bug（比如 `v-for` 里的 ref 变成数组导致 `.focus()` 抛错）
 * 是「必定发生但完全静默」的 —— 异常在微任务里、没人捕获，界面上一点反应都没有，
 * 截图看不出来、日志里也没有。唯一的实证手段是在真实窗口里触发那次交互并读返回值。
 * 端口固定 9223（不用默认的 9222，避免和别的调试实例撞上）。
 * 必须在 app ready 之前调用，所以放在模块顶层。
 */
if (debugLog) app.commandLine.appendSwitch('remote-debugging-port', '9223')

/**
 * `TM_USER_DATA=<目录>` 时把整个用户数据目录换到别处。
 *
 * 用途是隔离测试：界面探针（spike/ui-probe.mjs）要往配置里 seed 假数据、还要
 * 真的改名字，跑在真实 userData 上会把用户的项目列表覆盖掉。换个一次性目录，
 * 探针怎么折腾都不影响本人使用。必须在任何 getPath('userData') 之前设置。
 */
const userDataOverride = process.env['TM_USER_DATA']
if (userDataOverride) {
  try {
    mkdirSync(userDataOverride, { recursive: true })
    app.setPath('userData', userDataOverride)
  } catch {
    // 换目录失败就退回默认位置，总比起不来好
  }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: ConfigStore | null = null
let processes: ProcessManager | null = null
/** 区分「用户关窗口」与「真的在退出」，避免退出流程被 close 拦截 */
let quitting = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 生成托盘图标。
 *
 * 不用外部图片文件，而是直接画一张 16×16 位图：
 * 少一个需要打包、需要管路径、在不同分辨率下还可能糊掉的二进制资源。
 * 注意 createFromBitmap 需要 **BGRA** 顺序，不是 RGBA。
 */
function makeTrayIcon(): NativeImage {
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 一个带边框的圆角方块，近似终端的轮廓
      const onBorder = (x === 1 || x === 14) && y >= 3 && y <= 12
      const onTopBottom = (y === 3 || y === 12) && x >= 1 && x <= 14
      const isPrompt = y >= 6 && y <= 9 && x >= 4 && x <= 10
      if (!onBorder && !onTopBottom && !isPrompt) continue

      const i = (y * size + x) * 4
      buffer[i] = 0xd8 // B
      buffer[i + 1] = 0x8a // G
      buffer[i + 2] = 0x4b // R  → #4b8ad8
      buffer[i + 3] = 0xff // A
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: currentBackground(),
    title: 'Terminal Manage',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 三项安全基线：渲染进程拿不到 Node，只能通过 preload 白名单通信
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 等渲染完成再显示，避免先闪一下白屏
  win.once('ready-to-show', () => {
    debugLog?.('[window] ready-to-show → show()')
    win.show()
  })

  win.webContents.on('did-finish-load', () => debugLog?.('[window] did-finish-load'))

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    debugLog?.(`[window] did-fail-load code=${code} desc=${desc} url=${url} mainFrame=${isMainFrame}`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    debugLog?.(`[window] render-process-gone ${JSON.stringify(details)}`)
  })

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    debugLog?.(`[window] preload-error path=${preloadPath} err=${String(error)}`)
  })

  win.webContents.on('console-message', (details) => {
    const p = details as unknown as {
      level?: string
      message?: string
      lineNumber?: number
      sourceId?: string
    }
    debugLog?.(`[renderer ${p.level ?? '?'}] ${p.message ?? ''} @ ${p.sourceId ?? '?'}:${p.lineNumber ?? 0}`)
  })

  // 外链一律交给系统浏览器 —— 绝不在应用窗口里打开任意网页
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('close', (event) => {
    // 关闭到托盘：进程还在跑，用户只是想收起界面
    if (!quitting && store?.settings.minimizeToTray) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('Terminal Manage')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        // 托盘菜单是建好就不再变的，没法在这里显示「已标记 3 条」这类动态
        // 信息 —— 所以标签直接把判据写清楚：只会拉起被标记的命令
        label: '启动已标记的命令',
        click: () => void (store && processes?.startAll(collectMarkedSpecs(store))),
      },
      {
        label: '全部停止',
        click: () => void processes?.stopAll(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', () => showWindow())
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  // 让任务栏图标与通知正确归属到本应用
  app.setAppUserModelId('com.terminalmanage.app')

  store = new ConfigStore()
  await store.load()

  /**
   * 主题必须在建窗口之前定下来。
   *
   * `nativeTheme.themeSource` 决定渲染进程的 `prefers-color-scheme`，
   * 而窗口的 `backgroundColor`（下面 createWindow 里）要取当前主题的实际底色。
   * 顺序反了的话，第一帧会用错颜色的底，然后才被页面盖掉。
   */
  applyThemeSource(store.settings.theme)

  processes = new ProcessManager(store.settings, {
    onStatus: (state) => broadcast(CH.EVT_PROCESS_STATUS, state),
    onLog: (nodeId, events) => broadcast(CH.EVT_PROCESS_LOG, { nodeId, events }),
    onExit: (info) => broadcast(CH.EVT_PROCESS_EXIT, info),
  })

  registerIpc({ store, processes, broadcast })

  // 用持久化的设置校正开机自启（用户可能在别处改过）
  app.setLoginItemSettings({ openAtLogin: store.settings.autoLaunch })

  mainWindow = createWindow()
  createTray()

  app.on('activate', () => showWindow())

  /**
   * 这里刻意**不再**自动拉起任何命令。
   *
   * v2 会在应用启动时把勾了「随应用启动」的命令一并拉起，实测是个坏默认：
   * 打开工具往往只是想看一眼日志或改个配置，却先被一堆 dev server 抢占了
   * CPU 和端口；而且它们与用户随后手点「启动已标记」拉起的那批混在一起，
   * 事后很难说清到底是谁起的。
   *
   * 现在「哪些命令要跑」完全由用户在卡片上标记、再手动点「启动已标记」决定，
   * 主进程只在收到那个指令时按 marked 挑目标（见 collectMarkedSpecs）。
   */
}

async function shutdown(): Promise<void> {
  try {
    // 必须先杀掉所有子进程树，否则退出后会留下一批占着端口的孤儿进程 ——
    // 这正是本工具要解决的问题，自己绝不能变成问题的一部分
    await processes?.dispose()
    await store?.flush()
  } catch (err) {
    console.error('[main] 退出清理失败：', err)
  } finally {
    tray?.destroy()
    tray = null
    app.exit(0)
  }
}

app.on('window-all-closed', () => {
  // 开启「关闭到托盘」时窗口只是 hide，不会走到这里；
  // 走到这里说明用户确实关掉了，就该退出
  app.quit()
})

app.on('before-quit', (event) => {
  // 已经在清理中就直接放行，否则会在 shutdown 完成前反复进入
  if (quitting) return
  event.preventDefault()
  quitting = true
  void shutdown()
})

/**
 * 单实例锁。
 *
 * 两个实例会共用同一份 config.json，并各自 spawn 一套 dev server 去抢
 * 同一个端口 —— 那正是这个工具试图消灭的混乱。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })
  void bootstrap()
}
