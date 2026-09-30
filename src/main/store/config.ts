import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  AppConfig,
  AppSettings,
  CommandCreateDTO,
  CommandNode,
  GroupCreateDTO,
  GroupNode,
  MoveNodeDTO,
  NodeUpdateDTO,
  PackageInfo,
  PackageScript,
  RescanResult,
  ShellKind,
  ThemeMode,
  TreeNode,
} from '@shared/types'
import {
  childrenOf,
  findNode,
  moveNode,
  nextOrder,
  normalizeTree,
  removeWithDescendants,
} from '../../shared/tree'

/**
 * v2 引入了可嵌套分组树，v1 是扁平的项目列表。
 *
 * v3 把命令上的 `autoStart` 改名为 `marked`，语义从「随应用启动时自动运行」
 * 变成「随『启动已标记』一起启动」（见 CommandNode.marked）。老配置的读取兼容
 * 写在 shared/tree.ts 的 normalizeTree 里（两个键都认），所以这里不需要
 * 额外的迁移分支 —— 写回时只写新名字。
 *
 * 没有装过用户数据时这里也不会被执行，但迁移代码必须现在就写对：
 * 等用户已经有了真实配置再回头补，就变成「升级即丢数据」。
 */
const CONFIG_VERSION = 3

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  logBufferLines: 5000,
  minimizeToTray: true,
  autoLaunch: false,
  launchDelayMs: 400,
  fontSize: 12,
  /**
   * 默认开启彩色。
   *
   * M0 实测发现本机环境变量里存在 NO_COLOR，会让 vite/chalk 主动关闭颜色，
   * 而此前我们无条件注入 FORCE_COLOR=1，Node 因此向 stderr 输出
   *   "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set."
   * 既污染日志首屏，也违背了用户的显式意图。
   *
   * 现在把它做成可见开关：开启 = 由本应用接管颜色（清除 NO_COLOR 并注入
   * FORCE_COLOR=1）；关闭 = 完全尊重外部环境。
   */
  forceColor: true,
  /** 「隐藏命令」是减噪手段，但藏了得有地方找回来 —— 这是那个兜底开关 */
  showHiddenCommands: false,
  /** 右侧上（卡片）下（日志）分栏，卡片区默认占 45% */
  splitRatio: 0.45,
  /**
   * 日志面板默认收起。
   *
   * 平时它只是一片滚动噪声，真正需要它的时刻只有一个 —— 某条命令失败了。那种
   * 时刻由渲染层自动展开（见 store 里 EVT_PROCESS_EXIT 的处理），所以默认收起
   * 不会让人错过报错。
   */
  logCollapsed: true,
}

/** splitRatio 的合法区间，太极端会让另一半几乎不可用 */
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.85

const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system']
const SHELLS: readonly ShellKind[] = ['cmd', 'powershell']

function defaultConfig(): AppConfig {
  return { version: CONFIG_VERSION, nodes: [], settings: { ...DEFAULT_SETTINGS } }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 逐字段校验地合并设置。
 *
 * 刻意不用 `{ ...DEFAULT_SETTINGS, ...raw }`：配置是用户可见、可手工编辑的
 * JSON，那里出现 `"theme": null` 是很容易发生的事，而对象展开会让 null
 * 覆盖掉默认值，一路传到界面或 spawn 处才炸。
 */
function mergeSettings(raw: unknown): AppSettings {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: AppSettings = { ...DEFAULT_SETTINGS }

  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    const value = src[key]
    if (value === undefined || value === null) continue
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue
    if (key === 'theme' && !THEMES.includes(value as ThemeMode)) continue
    ;(out as unknown as Record<string, unknown>)[key] = value
  }

  // 数值型设置在这里夹一下，手工编辑过的 JSON 不该能把界面搞成不可用
  out.splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, out.splitRatio))

  return out
}

// ---------------------------------------------------------------------------
// v1 → v2 迁移
// ---------------------------------------------------------------------------

interface LegacyProject {
  id?: unknown
  name?: unknown
  path?: unknown
  command?: unknown
  cwd?: unknown
  env?: unknown
  autoStart?: unknown
  group?: unknown
  shell?: unknown
  expectedPort?: unknown
  color?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

/**
 * 旧模型是「扁平项目列表 + 一个 group 字符串标签」，新模型是树。
 *
 * 映射方式是**每个旧项目变成一个绑定了目录的分组，里面放一条命令**，
 * 而不是「每个 group 名变成一个分组」。原因很实际：旧模型允许同名 group 下
 * 的项目各有各的 path，而新模型里一个分组只有一个 path —— 按名字合并会直接
 * 丢掉后面那些项目的目录。按项目拆分后一个字段都不丢。
 */
function migrateFromV1(projects: readonly LegacyProject[], warnings: string[]): TreeNode[] {
  const now = Date.now()
  const nodes: TreeNode[] = []
  /** 旧 group 名 → 新建的顶层分组 id */
  const topGroups = new Map<string, string>()

  for (const p of projects) {
    const legacyId = asString(p.id)
    if (!legacyId) continue

    const name = asString(p.name) ?? '未命名项目'
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : now
    const updatedAt = typeof p.updatedAt === 'number' ? p.updatedAt : createdAt
    const path = asString(p.path)
    const cwd = asString(p.cwd)

    if (cwd && cwd !== path) {
      warnings.push(
        `旧配置里「${name}」设置了自定义执行目录（${cwd}），` +
          `新模型不再支持单条命令覆盖目录，已改用项目目录 ${path ?? '(空)'}`,
      )
    }

    let parentId: string | null = null
    const legacyGroup = asString(p.group)
    if (legacyGroup) {
      let groupId = topGroups.get(legacyGroup)
      if (!groupId) {
        groupId = randomUUID()
        topGroups.set(legacyGroup, groupId)
        nodes.push({
          id: groupId,
          kind: 'group',
          parentId: null,
          order: nextOrder(nodes, null),
          name: legacyGroup,
          expanded: true,
          createdAt: now,
          updatedAt: now,
        })
      }
      parentId = groupId
    }

    const groupId = randomUUID()
    nodes.push({
      id: groupId,
      kind: 'group',
      parentId,
      order: nextOrder(nodes, parentId),
      name,
      path,
      expanded: true,
      createdAt,
      updatedAt,
    })

    nodes.push({
      id: legacyId,
      kind: 'command',
      parentId: groupId,
      order: 0,
      name,
      command: asString(p.command) ?? 'npm run dev',
      autoDiscovered: false,
      hidden: false,
      // 旧 schema 上这个键就叫 autoStart，读进来之后写进新模型的 `marked`
      marked: p.autoStart === true,
      shell: SHELLS.find((s) => s === p.shell) ?? 'cmd',
      env:
        p.env !== null && typeof p.env === 'object' && !Array.isArray(p.env)
          ? (p.env as Record<string, string>)
          : undefined,
      expectedPort: typeof p.expectedPort === 'number' ? p.expectedPort : undefined,
      color: asString(p.color),
      createdAt,
      updatedAt,
    })
  }

  warnings.push(`已从旧版配置迁移 ${projects.length} 个项目到分组树`)
  return nodes
}

/**
 * 配置仓库。
 *
 * 刻意不使用 electron-store：这里只有一个 JSON 文件，自己实现反而能控制
 * **原子写入** —— 配置是用户手工维护的项目清单，一旦写坏就全丢了。
 * 做法是先写临时文件再 rename（同分区 rename 是原子的）。
 *
 * 另外注意：这里只持久化**声明式配置**，绝不持久化进程状态。
 * ChildProcess 句柄无法序列化，App 重启后按配置重新 spawn 即可。
 */
export class ConfigStore {
  private data: AppConfig = defaultConfig()
  private readonly file: string
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | null = null
  /** 加载期间发现的问题（迁移、清洗），供界面提示用户 */
  private loadWarnings: string[] = []

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json')
  }

  async load(): Promise<AppConfig> {
    const warnings: string[] = []
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      this.data = this.migrate(parsed, warnings)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 配置损坏时不能直接清空 —— 先备份，用户还有机会手工抢救
        console.error('[config] 读取失败，已备份为 config.json.bak：', err)
        await fs.rename(this.file, `${this.file}.bak`).catch(() => undefined)
        warnings.push(`配置文件读取失败（${(err as Error).message}），已备份为 config.json.bak 并重新开始`)
      }
      this.data = defaultConfig()
    }
    this.loadWarnings = warnings
    return this.data
  }

  private migrate(parsed: Record<string, unknown>, warnings: string[]): AppConfig {
    const isLegacy = Array.isArray(parsed.projects) && !Array.isArray(parsed.nodes)

    return {
      version: CONFIG_VERSION,
      nodes: isLegacy
        ? migrateFromV1(parsed.projects as LegacyProject[], warnings)
        : normalizeTree(parsed.nodes, warnings),
      settings: mergeSettings(parsed.settings),
    }
  }

  get all(): AppConfig {
    return this.data
  }

  get nodes(): TreeNode[] {
    return this.data.nodes
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  get warnings(): readonly string[] {
    return this.loadWarnings
  }

  find(id: string): TreeNode | undefined {
    return findNode(this.data.nodes, id)
  }

  // -------------------------------------------------------------------------
  // 树操作
  // -------------------------------------------------------------------------

  createGroup(dto: GroupCreateDTO): GroupNode {
    const now = Date.now()
    const parentId = dto.parentId
    if (parentId !== null) {
      const parent = findNode(this.data.nodes, parentId)
      if (!parent) throw new Error(`父分组不存在：${parentId}`)
      if (parent.kind !== 'group') throw new Error('命令不能作为容器')
    }

    const group: GroupNode = {
      id: randomUUID(),
      kind: 'group',
      parentId,
      order: nextOrder(this.data.nodes, parentId),
      name: asString(dto.name) ?? '新建分组',
      path: asString(dto.path),
      expanded: true,
      createdAt: now,
      updatedAt: now,
    }
    this.data.nodes.push(group)
    this.scheduleSave()
    return group
  }

  createCommand(dto: CommandCreateDTO): CommandNode {
    const parent = findNode(this.data.nodes, dto.parentId)
    if (!parent) throw new Error(`分组不存在：${dto.parentId}`)
    if (parent.kind !== 'group') throw new Error('只能在分组下新建命令')

    const now = Date.now()
    const command = asString(dto.command) ?? 'npm run dev'
    const node: CommandNode = {
      id: randomUUID(),
      kind: 'command',
      parentId: dto.parentId,
      order: nextOrder(this.data.nodes, dto.parentId),
      name: asString(dto.name) ?? command,
      script: asString(dto.script),
      command,
      autoDiscovered: false,
      hidden: false,
      marked: dto.marked === true,
      shell: SHELLS.find((s) => s === dto.shell) ?? 'cmd',
      env: dto.env,
      expectedPort: dto.expectedPort,
      color: dto.color,
      createdAt: now,
      updatedAt: now,
    }
    this.data.nodes.push(node)
    this.scheduleSave()
    return node
  }

  /**
   * 批量挂载从 package.json 读到的脚本。
   *
   * 一次 push 完再统一存盘：scheduleSave 有 300ms 合并窗口，
   * 逐条调用会白白触发一堆定时器重置。
   */
  addScriptCommands(
    groupId: string,
    scripts: readonly PackageScript[],
    toCommand: (key: string) => string,
  ): CommandNode[] {
    const parent = findNode(this.data.nodes, groupId)
    if (parent?.kind !== 'group') throw new Error(`分组不存在：${groupId}`)

    const now = Date.now()
    const created: CommandNode[] = []
    for (const script of scripts) {
      const node: CommandNode = {
        id: randomUUID(),
        kind: 'command',
        parentId: groupId,
        order: nextOrder(this.data.nodes, groupId),
        name: script.key,
        script: script.key,
        command: toCommand(script.key),
        autoDiscovered: true,
        hidden: false,
        marked: false,
        shell: 'cmd',
        createdAt: now,
        updatedAt: now,
      }
      this.data.nodes.push(node)
      created.push(node)
    }
    if (created.length) this.scheduleSave()
    return created
  }

  /**
   * 按白名单字段更新节点。
   *
   * 不用 `Object.assign(node, patch)`：patch 来自 IPC 边界，理论上可以被构造
   * 成带上 `kind` / `parentId` / `autoDiscovered`，直接展开会让渲染进程
   * 拥有改写树结构的能力，绕过 move 里的环检测。
   */
  update(dto: NodeUpdateDTO): TreeNode | undefined {
    const node = findNode(this.data.nodes, dto.id)
    if (!node) return undefined

    if (dto.name !== undefined) node.name = asString(dto.name) ?? node.name

    if (node.kind === 'group') {
      if ('path' in dto) node.path = asString(dto.path)
      if (dto.expanded !== undefined) node.expanded = dto.expanded
    } else {
      if (dto.command !== undefined) {
        const next = asString(dto.command)
        // 先比对再赋值 —— 反过来写的话比较的永远是刚写进去的新值
        if (next && next !== node.command) {
          node.command = next
          // 用户亲手改过命令之后，重新扫描就不能再覆盖它了
          node.autoDiscovered = false
        }
      }
      if (dto.shell !== undefined) node.shell = SHELLS.find((s) => s === dto.shell) ?? node.shell
      if ('env' in dto) {
        node.env =
          dto.env !== null && typeof dto.env === 'object' && !Array.isArray(dto.env)
            ? dto.env
            : undefined
      }
      if (dto.marked !== undefined) node.marked = dto.marked
      if (dto.hidden !== undefined) node.hidden = dto.hidden
      if ('expectedPort' in dto) {
        node.expectedPort =
          typeof dto.expectedPort === 'number' && Number.isFinite(dto.expectedPort)
            ? dto.expectedPort
            : undefined
      }
      if ('color' in dto) node.color = asString(dto.color)
    }

    node.updatedAt = Date.now()
    this.scheduleSave()
    return node
  }

  /** 删除节点及其全部后代，返回被删掉的 id（调用方据此清理运行中的进程） */
  remove(id: string): string[] {
    const doomed = removeWithDescendants(this.data.nodes, id)
    if (doomed.length) this.scheduleSave()
    return doomed
  }

  move(dto: MoveNodeDTO): boolean {
    moveNode(this.data.nodes, dto)
    this.scheduleSave()
    return true
  }

  /**
   * 重新扫描一个分组的 package.json，把树对齐到当前脚本集合。
   *
   * 三条规则：
   *   - 出现新 script        → 新建命令节点
   *   - script 内容变了且节点仍是 autoDiscovered → 跟随刷新 command
   *   - script 消失了        → 只标 missing，**不删**
   * 最后一条是关键：节点上可能有用户起的名字、隐藏设置、标记（marked），
   * 因为一次临时改名就把它们扔掉，代价远大于留一个灰条。
   */
  applyRescan(groupId: string, info: PackageInfo, toCommand: (key: string) => string): RescanResult {
    const group = findNode(this.data.nodes, groupId)
    if (group?.kind !== 'group') throw new Error(`分组不存在：${groupId}`)

    const result: RescanResult = {
      added: 0,
      newlyMissing: 0,
      restored: 0,
      updated: 0,
      warnings: [...info.warnings],
    }

    const byScript = new Map<string, PackageScript>()
    for (const script of info.scripts) byScript.set(script.key, script)

    const existing = childrenOf(this.data.nodes, groupId).filter(
      (n): n is CommandNode => n.kind === 'command' && Boolean(n.script),
    )
    const knownKeys = new Set(existing.map((n) => n.script as string))

    for (const node of existing) {
      const script = byScript.get(node.script as string)
      if (!script) {
        if (!node.missing) {
          node.missing = true
          node.updatedAt = Date.now()
          result.newlyMissing += 1
        }
        continue
      }
      if (node.missing) {
        node.missing = undefined
        node.updatedAt = Date.now()
        result.restored += 1
      }
      const next = toCommand(script.key)
      if (node.autoDiscovered && node.command !== next) {
        node.command = next
        node.updatedAt = Date.now()
        result.updated += 1
      }
    }

    const fresh = info.scripts.filter((s) => !knownKeys.has(s.key))
    result.added = this.addScriptCommands(groupId, fresh, toCommand).length

    this.scheduleSave()
    return result
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = mergeSettings({ ...this.data.settings, ...patch })
    this.scheduleSave()
    return this.data.settings
  }

  /** 合并 300ms 内的连续修改，避免批量操作时反复写盘 */
  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 300)
  }

  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // 串行化，避免两次 save 交错写同一个临时文件
    while (this.saving) await this.saving

    this.saving = (async () => {
      const tmp = `${this.file}.tmp`
      try {
        await fs.mkdir(dirname(this.file), { recursive: true })
        await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
        await fs.rename(tmp, this.file)
      } catch (err) {
        console.error('[config] 保存失败：', err)
      } finally {
        this.saving = null
      }
    })()

    await this.saving
  }

  /** 退出前调用，确保挂起的写入落盘 */
  async flush(): Promise<void> {
    await this.save()
  }
}
