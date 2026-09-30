import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type {
  PackageInfo,
  PackageManager,
  PackageScript,
  PackageWorkspace,
} from '@shared/types'

/**
 * package.json / monorepo 解析。
 *
 * 这个是本工具「自动去读所属项目的命令」的全部实现。刻意不引第三方依赖
 * （项目运行时依赖只有 ansi_up 一个），所以 glob 与 pnpm-workspace.yaml
 * 都是按实际用到的形状手写的，能力边界见各函数注释。
 */

/** 探测包管理器时按这个顺序查锁文件 —— 越靠前优先级越高 */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

const MANAGER_NAMES: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']

/** 展开 workspaces 时跳过的目录名 —— 进入这些目录只会拖慢扫描且毫无意义 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', '.next', '.nuxt', 'coverage'])

/** `**` 递归展开的深度上限，防止误写 pattern 时扫爆整块磁盘 */
const MAX_GLOB_DEPTH = 6

async function isDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile()
  } catch {
    return false
  }
}

/** 读 JSON。解析失败只记警告不抛 —— 一个坏掉的 package.json 不该让整个界面炸掉 */
async function readJsonObject(
  file: string,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${file} 的顶层不是一个对象，已忽略`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      warnings.push(`${file} 解析失败：${(err as Error).message}`)
    }
    return null
  }
}

/**
 * 读取 `scripts` 字段。
 *
 * 只保留字符串值 —— 手工编辑过的 package.json 里出现 null / 对象是常见事，
 * 直接把非字符串塞进命令行会 spawn 出一个莫名其妙的 shell 错误。
 */
function readScripts(pkg: Record<string, unknown> | null): PackageScript[] {
  const raw = pkg?.scripts
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({ key, value }))
}

/**
 * 探测包管理器。
 *
 * 两步：先看 package.json 的 `packageManager` 字段（corepack 写入的
 * "pnpm@9.1.0" 形态，最权威），再按锁文件判断。
 *
 * 锁文件要**向上找**：monorepo 的子包里根本没有锁文件，锁文件在仓库根目录。
 * 不向上找的话，一个 pnpm 仓库里的子包会被误判成 npm，命令前缀写错。
 */
async function detectPackageManager(
  dir: string,
  pkg: Record<string, unknown> | null,
): Promise<PackageManager> {
  const declared = pkg?.packageManager
  if (typeof declared === 'string') {
    const name = declared.split('@')[0]?.trim().toLowerCase()
    const hit = MANAGER_NAMES.find((m) => m === name)
    if (hit) return hit
  }

  let cursor = resolve(dir)
  for (let depth = 0; depth < 5; depth += 1) {
    for (const [file, manager] of LOCKFILES) {
      if (await isFile(join(cursor, file))) return manager
    }
    const parent = resolve(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }

  return 'npm'
}

/** 立即子目录（绝对路径），跳过 node_modules / .git 等噪音 */
async function listSubDirs(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    // 显式写 encoding:'utf8'：不写的话 readdir 的返回类型会退化成
    // Dirent<Buffer>，e.name 变成 Buffer，后续的字符串比较全部报错。
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name))
}

async function listSubDirsRecursive(dir: string, depth: number): Promise<string[]> {
  if (depth <= 0) return []
  const direct = await listSubDirs(dir)
  const nested = await Promise.all(direct.map((d) => listSubDirsRecursive(d, depth - 1)))
  return [...direct, ...nested.flat()]
}

/**
 * 展开一个 workspace glob。
 *
 * 支持的能力（覆盖实际见过的全部写法）：
 *   - 字面路径        packages/web
 *   - 单层通配        packages/*
 *   - 段内部分通配     packages/internal-*
 *   - 任意层通配      packages/**
 * 通配只匹配**目录**。glob 语义里 `*` 也匹配文件，但 workspaces 只可能指向
 * 目录，多匹配文件反而要在下游多写一层过滤。
 */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  let level: string[] = [root]

  for (const segment of segments) {
    const next: string[] = []
    for (const base of level) {
      if (segment === '*') {
        next.push(...(await listSubDirs(base)))
      } else if (segment === '**') {
        next.push(...(await listSubDirsRecursive(base, MAX_GLOB_DEPTH)))
      } else if (segment.includes('*')) {
        // 段内通配，例如 `internal-*` 或 `*-app`。少了这一条，
        // pnpm 文档里常见的 `!packages/internal-*` 排除项会静默失效 ——
        // 排除项失效不会报错，只会多出几个不该出现的子包，很难发现。
        const matcher = segmentToRegExp(segment)
        for (const sub of await listSubDirs(base)) {
          if (matcher.test(basename(sub))) next.push(sub)
        }
      } else {
        const candidate = join(base, segment)
        if (await isDir(candidate)) next.push(candidate)
      }
    }
    if (next.length === 0) return []
    level = next
  }

  return level
}

/** 把带 `*` 的单个路径段编译成正则。`*` 匹配段内任意字符（含空串）。 */
function segmentToRegExp(segment: string): RegExp {
  const pattern = segment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  // Windows 的文件名比较不区分大小写，这里跟着放宽
  return new RegExp(`^${pattern}$`, 'i')
}

/**
 * 读 workspaces 声明。
 *
 * 两个来源，缺一不可：
 *   - `package.json#workspaces`：npm / yarn 用，可以是数组或 `{ packages: [] }`
 *   - `pnpm-workspace.yaml`：**pnpm 只认这个文件**，忽略 package.json 的
 *     workspaces 字段。pnpm 在 Vue 生态里占比很高，漏掉它会直接导致
 *     monorepo 项目展开不出任何子包。
 *
 * YAML 解析刻意只覆盖 `pnpm-workspace.yaml` 的实际形状（一个 packages 列表），
 * 不做通用 YAML —— 引入一个 YAML 库只为读这一个字段不划算。遇到不认识的
 * 结构会记一条警告并降级，而不是静默给出错误结果。
 */
async function readWorkspacePatterns(
  dir: string,
  pkg: Record<string, unknown> | null,
  warnings: string[],
): Promise<string[]> {
  const yamlPath = join(dir, 'pnpm-workspace.yaml')
  if (await isFile(yamlPath)) {
    try {
      const text = await fs.readFile(yamlPath, 'utf-8')
      const patterns = parsePackagesList(text)
      if (patterns.length > 0) return patterns
      warnings.push('pnpm-workspace.yaml 里没有解析出 packages 列表，已跳过')
    } catch (err) {
      warnings.push(`pnpm-workspace.yaml 读取失败：${(err as Error).message}`)
    }
  }

  const declared = pkg?.workspaces
  if (Array.isArray(declared)) {
    return declared.filter((p): p is string => typeof p === 'string')
  }
  if (declared !== null && typeof declared === 'object') {
    const inner = (declared as { packages?: unknown }).packages
    if (Array.isArray(inner)) return inner.filter((p): p is string => typeof p === 'string')
  }

  return []
}

/**
 * 从 pnpm-workspace.yaml 的文本里抠出 `packages:` 下的列表项。
 *
 * 只认两种写法：
 *   packages:
 *     - 'packages/*'
 *   packages: ['packages/*']      ← 行内数组
 * 列表在遇到下一个顶层键（顶格且以字母开头的 `key:`）时结束。
 */
function parsePackagesList(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inPackages = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const topLevel = /^[A-Za-z_][\w-]*\s*:/.test(line)
    if (topLevel) {
      const key = line.slice(0, line.indexOf(':')).trim()
      inPackages = key === 'packages'

      if (inPackages) {
        const inline = line.slice(line.indexOf(':') + 1).trim()
        if (inline.startsWith('[')) {
          for (const item of inline.replace(/^\[|\]$/g, '').split(',')) {
            const value = stripQuotes(item.trim())
            if (value) out.push(value)
          }
        }
      }
      continue
    }

    if (!inPackages) continue
    if (!trimmed.startsWith('-')) continue
    const value = stripQuotes(trimmed.slice(1).trim())
    if (value) out.push(value)
  }

  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 展开 workspaces 并逐个读取子包。
 *
 * 支持 `!` 前缀的排除项：先展开全部正向 pattern，再展开排除项，
 * 最后做差集。pnpm 官方文档里那种「排除测试目录」的写法就靠这一步。
 */
async function readWorkspaces(
  dir: string,
  pkg: Record<string, unknown> | null,
  warnings: string[],
): Promise<PackageWorkspace[]> {
  const patterns = await readWorkspacePatterns(dir, pkg, warnings)
  if (patterns.length === 0) return []

  const included = patterns.filter((p) => !p.startsWith('!'))
  const excluded = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))

  const dirs = new Set<string>()
  for (const pattern of included) {
    for (const hit of await expandPattern(dir, pattern)) dirs.add(resolve(hit))
  }
  for (const pattern of excluded) {
    for (const hit of await expandPattern(dir, pattern)) dirs.delete(resolve(hit))
  }

  const workspaces: PackageWorkspace[] = []
  for (const sub of [...dirs].sort()) {
    const subPkgPath = join(sub, 'package.json')
    if (!(await isFile(subPkgPath))) {
      warnings.push(`${sub} 命中 workspaces 但没有 package.json，已跳过`)
      continue
    }
    const subWarnings: string[] = []
    const subPkg = await readJsonObject(subPkgPath, subWarnings)
    warnings.push(...subWarnings)

    const declaredName = subPkg?.name
    workspaces.push({
      dir: sub,
      name: typeof declaredName === 'string' && declaredName.trim() ? declaredName : basename(sub),
      scripts: readScripts(subPkg),
    })
  }

  return workspaces
}

/**
 * 解析一个目录：是否 Vue 项目不管，只要有 package.json 就有可读的命令。
 *
 * @param withWorkspaces 是否展开 workspaces。重新扫描时用不到，关掉能省一次
 *   完整的目录遍历。
 */
export async function readPackageInfo(
  inputDir: string,
  withWorkspaces = true,
): Promise<PackageInfo> {
  const dir = resolve(inputDir)
  const warnings: string[] = []

  if (!(await isDir(dir))) {
    return {
      dir,
      found: false,
      packageManager: 'npm',
      scripts: [],
      workspaces: [],
      warnings: [`目录不存在或不是目录：${dir}`],
    }
  }

  const pkg = await readJsonObject(join(dir, 'package.json'), warnings)
  const packageManager = await detectPackageManager(dir, pkg)
  const declaredName = pkg?.name

  return {
    dir,
    found: pkg !== null,
    name: typeof declaredName === 'string' && declaredName.trim() ? declaredName : undefined,
    packageManager,
    scripts: readScripts(pkg),
    workspaces: withWorkspaces ? await readWorkspaces(dir, pkg, warnings) : [],
    warnings,
  }
}

/**
 * script key → 实际命令行。
 *
 * 统一加 `run`：npm/pnpm/yarn/bun 四家都支持 `run` 前缀，
 * 而省略 `run` 的简写形式各家行为不一致（yarn 的 `yarn dev` 虽然能用，
 * 但遇到与内建命令同名的 script 会被内建命令抢走）。
 */
export function scriptToCommand(packageManager: PackageManager, key: string): string {
  return `${packageManager} run ${key}`
}

/** 分组显示名：package.json 的 name 优先，退回目录名 */
export function defaultGroupName(info: Pick<PackageInfo, 'name' | 'dir'>): string {
  return info.name?.trim() || basename(info.dir) || info.dir
}
