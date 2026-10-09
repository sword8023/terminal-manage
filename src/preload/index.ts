import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH, EVENT_CHANNELS } from '@shared/channels'
import type { EventChannel, EventMap, TerminalManageApi } from '@shared/api'

/**
 * 拆信封。
 *
 * 主进程的处理器统一返回 `{ ok, data | error }`。这里把它还原成
 * 「正常返回 / throw Error」两种形态，渲染进程就不必在每个调用点判空。
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, ...args)

  if (raw !== null && typeof raw === 'object' && 'ok' in raw) {
    const envelope = raw as { ok: boolean; data?: unknown; error?: string }
    if (!envelope.ok) throw new Error(envelope.error ?? '主进程返回了未知错误')
    return envelope.data as T
  }

  return raw as T
}

type RawListener = (event: IpcRendererEvent, ...args: unknown[]) => void

function onEvent<K extends EventChannel>(
  channel: K,
  listener: (payload: EventMap[K]) => void,
): () => void {
  // 白名单校验：即便渲染进程被注入脚本，也无法订阅任意通道
  if (!EVENT_CHANNELS.includes(channel)) {
    throw new Error(`非法的事件通道：${channel}`)
  }

  const wrapped: RawListener = (_event, payload) => listener(payload as EventMap[K])
  ipcRenderer.on(channel, wrapped)

  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: TerminalManageApi = {
  tree: {
    list: () => invoke(CH.TREE_LIST),
    createGroup: (dto) => invoke(CH.TREE_CREATE_GROUP, dto),
    createGroupFromDir: (dto) => invoke(CH.TREE_CREATE_GROUP_FROM_DIR, dto),
    createCommand: (dto) => invoke(CH.TREE_CREATE_COMMAND, dto),
    update: (dto) => invoke(CH.TREE_UPDATE, dto),
    remove: (id) => invoke(CH.TREE_DELETE, id),
    move: (dto) => invoke(CH.TREE_MOVE, dto),
    rescan: (groupId) => invoke(CH.PKG_RESCAN, groupId),
  },

  pkg: {
    inspect: (dir) => invoke(CH.PKG_INSPECT, dir),
  },

  processes: {
    start: (id) => invoke(CH.PROCESS_START, id),
    stop: (id) => invoke(CH.PROCESS_STOP, id),
    restart: (id) => invoke(CH.PROCESS_RESTART, id),
    startAll: () => invoke(CH.PROCESS_START_ALL),
    stopAll: () => invoke(CH.PROCESS_STOP_ALL),
    snapshot: () => invoke(CH.PROCESS_SNAPSHOT),
  },

  logs: {
    snapshot: (id) => invoke(CH.LOG_SNAPSHOT, id),
    clear: (id) => invoke(CH.LOG_CLEAR, id),
  },

  settings: {
    get: () => invoke(CH.SETTING_GET),
    update: (patch) => invoke(CH.SETTING_UPDATE, patch),
  },

  shell: {
    openPath: (target) => invoke(CH.SHELL_OPEN_PATH, target),
    openUrl: (url) => invoke(CH.SHELL_OPEN_URL, url),
    pickDir: () => invoke(CH.SHELL_PICK_DIR),
  },

  port: {
    check: (port) => invoke(CH.PORT_CHECK, port),
  },

  env: {
    info: () => invoke(CH.ENV_INFO),
  },

  update: {
    snapshot: () => invoke(CH.UPDATE_SNAPSHOT),
    check: () => invoke(CH.UPDATE_CHECK),
    download: () => invoke(CH.UPDATE_DOWNLOAD),
    cancel: () => invoke(CH.UPDATE_CANCEL),
    reveal: () => invoke(CH.UPDATE_REVEAL),
    install: (options) => invoke(CH.UPDATE_INSTALL, options),
  },

  on: onEvent,
}

contextBridge.exposeInMainWorld('api', api)
