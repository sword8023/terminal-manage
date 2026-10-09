/**
 * IPC 通道常量 —— 主进程与渲染进程共用，避免魔法字符串。
 */
export const CH = {
  // ---- 请求-响应（renderer → main，invoke/handle）----
  TREE_LIST: 'tree:list',
  TREE_CREATE_GROUP: 'tree:createGroup',
  TREE_CREATE_GROUP_FROM_DIR: 'tree:createGroupFromDir',
  TREE_CREATE_COMMAND: 'tree:createCommand',
  TREE_UPDATE: 'tree:update',
  TREE_DELETE: 'tree:delete',
  TREE_MOVE: 'tree:move',

  PKG_INSPECT: 'pkg:inspect',
  PKG_RESCAN: 'pkg:rescan',

  PROCESS_START: 'process:start',
  PROCESS_STOP: 'process:stop',
  PROCESS_RESTART: 'process:restart',
  PROCESS_START_ALL: 'process:startAll',
  PROCESS_STOP_ALL: 'process:stopAll',
  PROCESS_SNAPSHOT: 'process:snapshot',

  LOG_SNAPSHOT: 'log:snapshot',
  LOG_CLEAR: 'log:clear',

  SETTING_GET: 'setting:get',
  SETTING_UPDATE: 'setting:update',

  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_OPEN_URL: 'shell:openUrl',
  SHELL_PICK_DIR: 'shell:pickDir',
  PORT_CHECK: 'port:check',
  ENV_INFO: 'env:info',

  // ---- 更新（升级）----
  UPDATE_SNAPSHOT: 'update:snapshot',
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL: 'update:cancel',
  // 打开安装包所在文件夹：SmartScreen 拦下静默安装时，这是唯一的兜底出口
  UPDATE_REVEAL: 'update:reveal',
  // 静默安装 + 退出。这一步之后应用会自己结束，重启由安装器的 runAfterFinish 负责
  UPDATE_INSTALL: 'update:install',

  // ---- 事件推送（main → renderer，send/on）----
  EVT_PROCESS_STATUS: 'evt:process:status',
  EVT_PROCESS_LOG: 'evt:process:log',
  EVT_PROCESS_EXIT: 'evt:process:exit',
  EVT_TREE_CHANGED: 'evt:tree:changed',
  EVT_SETTINGS_CHANGED: 'evt:settings:changed',
  EVT_UPDATE_STATUS: 'evt:update:status',
} as const

export type Channel = (typeof CH)[keyof typeof CH]

/** 渲染进程可订阅的事件通道白名单 */
export const EVENT_CHANNELS: readonly string[] = [
  CH.EVT_PROCESS_STATUS,
  CH.EVT_PROCESS_LOG,
  CH.EVT_PROCESS_EXIT,
  CH.EVT_TREE_CHANGED,
  CH.EVT_SETTINGS_CHANGED,
  CH.EVT_UPDATE_STATUS,
]
