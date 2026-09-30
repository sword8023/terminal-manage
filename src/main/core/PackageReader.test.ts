import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { defaultGroupName, readPackageInfo, scriptToCommand } from './PackageReader.ts'

// ---------------------------------------------------------------------------
// 临时夹具
// ---------------------------------------------------------------------------

/** 每个用例一个独立临时目录，结束后删掉 —— 用例之间不能互相污染 */
async function makeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tm-pkg-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeText(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), text, 'utf-8')
}

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await writeText(dir, name, JSON.stringify(data, null, 2))
}

/** 建一个最简子包 */
async function makeSubPackage(root: string, rel: string, name: string, scripts: unknown): Promise<void> {
  await writeJson(join(root, rel), 'package.json', { name, scripts })
}

// ---------------------------------------------------------------------------
// 基础读取
// ---------------------------------------------------------------------------

test('读取普通 npm 项目的 name 与 scripts', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    name: 'my-vue-app',
    scripts: { dev: 'vite', build: 'vue-tsc && vite build', preview: 'vite preview' },
  })
  await writeText(root, 'package-lock.json', '{}')

  const info = await readPackageInfo(root)
  assert.equal(info.found, true)
  assert.equal(info.name, 'my-vue-app')
  assert.equal(info.packageManager, 'npm')
  assert.deepEqual(
    info.scripts.map((s) => s.key),
    ['dev', 'build', 'preview'],
  )
  assert.equal(info.scripts[0]?.value, 'vite')
  assert.deepEqual(info.warnings, [])
})

test('scripts 里非字符串的值被过滤掉', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    scripts: { dev: 'vite', broken: null, weird: { a: 1 }, num: 3, ok: 'echo hi' },
  })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.scripts.map((s) => s.key),
    ['dev', 'ok'],
  )
})

test('目录不存在时返回 found:false 并带警告，而不是抛错', async () => {
  const info = await readPackageInfo(join(tmpdir(), 'tm-does-not-exist-987654321'))
  assert.equal(info.found, false)
  assert.deepEqual(info.scripts, [])
  assert.equal(info.warnings.length, 1)
  assert.match(info.warnings[0] ?? '', /目录不存在/)
})

test('目录里没有 package.json 时 found:false，且不产生噪音警告', async (t) => {
  const root = await makeRoot(t)
  const info = await readPackageInfo(root)
  assert.equal(info.found, false)
  assert.equal(info.name, undefined)
  // ENOENT 是「这里没有」而不是「这里坏了」，不该打扰用户
  assert.deepEqual(info.warnings, [])
})

test('package.json 语法坏掉时记警告并降级，不让调用方炸掉', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'package.json', '{ "name": "oops", ')

  const info = await readPackageInfo(root)
  assert.equal(info.found, false)
  assert.equal(info.warnings.length, 1)
  assert.match(info.warnings[0] ?? '', /解析失败/)
})

test('package.json 顶层是数组时按无效处理', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'package.json', '["not", "an", "object"]')

  const info = await readPackageInfo(root)
  assert.equal(info.found, false)
  assert.match(info.warnings.join('|'), /顶层不是一个对象/)
})

// ---------------------------------------------------------------------------
// 包管理器探测
// ---------------------------------------------------------------------------

test('packageManager 字段优先于锁文件，且能剥掉版本号', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    name: 'x',
    packageManager: 'pnpm@9.1.0',
    scripts: { dev: 'vite' },
  })
  // 故意放一个 npm 的锁文件，验证它没有抢走判断权
  await writeText(root, 'package-lock.json', '{}')

  const info = await readPackageInfo(root)
  assert.equal(info.packageManager, 'pnpm')
  assert.equal(scriptToCommand(info.packageManager, 'dev'), 'pnpm run dev')
})

test('packageManager 字段写着不认识的包管理器时回落到锁文件', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'x', packageManager: 'cnpm@1.0.0' })
  await writeText(root, 'yarn.lock', '')

  const info = await readPackageInfo(root)
  assert.equal(info.packageManager, 'yarn')
})

test('按 yarn.lock 探测出 yarn', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'x', scripts: { dev: 'vite' } })
  await writeText(root, 'yarn.lock', '')

  const info = await readPackageInfo(root)
  assert.equal(info.packageManager, 'yarn')
})

test('子包自己没有锁文件时，向上层目录找到仓库根的锁文件', async (t) => {
  const root = await makeRoot(t)
  // monorepo 根的锁文件
  await writeText(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  await writeJson(root, 'package.json', { name: 'monorepo' })
  // 子包只有 package.json
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })

  const info = await readPackageInfo(join(root, 'packages', 'web'))
  assert.equal(info.packageManager, 'pnpm')
})

test('pnpm-workspace.yaml 存在时优先于 package.json#workspaces', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'root', workspaces: ['apps/*'] })
  await writeText(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")

  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await makeSubPackage(root, 'apps/site', '@demo/site', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
})

// ---------------------------------------------------------------------------
// workspaces 展开
// ---------------------------------------------------------------------------

test('展开 workspaces 数组，读回子包的 name 与 scripts', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    name: 'monorepo',
    workspaces: ['packages/*'],
  })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite', build: 'vue-tsc' })
  await makeSubPackage(root, 'packages/ui', '@demo/ui', { build: 'vite build' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/ui', '@demo/web'],
  )
  const web = info.workspaces.find((w) => w.name === '@demo/web')
  assert.deepEqual(
    web?.scripts.map((s) => s.key),
    ['dev', 'build'],
  )
  assert.equal(web?.dir, join(root, 'packages', 'web'))
})

test('workspaces 的 { packages: [...] } 对象写法同样支持', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    name: 'monorepo',
    workspaces: { packages: ['packages/*'] },
  })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
})

test('子包没有 package.json 时被跳过并记警告', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'monorepo', workspaces: ['packages/*'] })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  // 这个目录命中通配但没有 package.json
  await mkdir(join(root, 'packages', 'empty'), { recursive: true })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
  assert.match(info.warnings.join('|'), /没有 package\.json/)
})

test('`*` 只匹配目录，不会把同名文件当成子包', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'monorepo', workspaces: ['packages/*'] })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await writeText(root, join('packages', 'README.md'), '# 不是子包')

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => basename(w.dir)),
    ['web'],
  )
})

test('`!` 前缀的排除项会从结果里去掉', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', {
    name: 'monorepo',
    workspaces: ['packages/*', '!packages/internal-*'],
  })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await makeSubPackage(root, 'packages/internal-tool', '@demo/internal', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
})

test('`**` 递归展开多层子包', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'monorepo', workspaces: ['libs/**'] })
  await makeSubPackage(root, 'libs/a', '@demo/a', { dev: 'vite' })
  await makeSubPackage(root, 'libs/nested/b', '@demo/b', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/a', '@demo/b'],
  )
})

test('展开 workspaces 时会跳过 node_modules 这类噪音目录', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'monorepo', workspaces: ['**'] })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await makeSubPackage(root, 'node_modules/dep', 'dep', { dev: 'nope' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
})

test('没有 workspaces 声明时返回空数组而不是报错', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'single', scripts: { dev: 'vite' } })

  const info = await readPackageInfo(root)
  assert.deepEqual(info.workspaces, [])
})

test('withWorkspaces=false 时完全不做目录遍历', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'monorepo', workspaces: ['packages/*'] })
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })

  const info = await readPackageInfo(root, false)
  assert.deepEqual(info.workspaces, [])
  // 但根自己的 scripts 照读
  assert.deepEqual(info.scripts, [])
  assert.equal(info.name, 'monorepo')
})

// ---------------------------------------------------------------------------
// pnpm-workspace.yaml 手写解析
// ---------------------------------------------------------------------------

test('pnpm-workspace.yaml 的连字符列表被解析出来', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'root' })
  await writeText(
    root,
    'pnpm-workspace.yaml',
    ['packages:', "  - 'packages/*'", '  - "apps/*"', '', '# 注释行', 'onlyBuiltDependencies:', '  - esbuild'].join('\n'),
  )
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await makeSubPackage(root, 'apps/site', '@demo/site', { dev: 'vite' })
  // 顶层换键之后的列表不能被误当成 packages
  await makeSubPackage(root, 'onlyBuiltDependencies/esbuild', 'wrong', { dev: 'x' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/site', '@demo/web'],
  )
})

test('pnpm-workspace.yaml 的行内数组写法被解析出来', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'root' })
  await writeText(root, 'pnpm-workspace.yaml', "packages: ['packages/*', \"apps/*\"]\n")
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })
  await makeSubPackage(root, 'apps/site', '@demo/site', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/site', '@demo/web'],
  )
})

test('pnpm-workspace.yaml 里解析不出 packages 时记警告并回落到 package.json', async (t) => {
  const root = await makeRoot(t)
  await writeJson(root, 'package.json', { name: 'root', workspaces: ['packages/*'] })
  await writeText(root, 'pnpm-workspace.yaml', 'somethingElse: true\n')
  await makeSubPackage(root, 'packages/web', '@demo/web', { dev: 'vite' })

  const info = await readPackageInfo(root)
  assert.deepEqual(
    info.workspaces.map((w) => w.name),
    ['@demo/web'],
  )
  assert.match(info.warnings.join('|'), /没有解析出 packages/)
})

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('scriptToCommand 一律带 run，避开与各家内建命令重名', () => {
  assert.equal(scriptToCommand('npm', 'dev'), 'npm run dev')
  assert.equal(scriptToCommand('pnpm', 'build'), 'pnpm run build')
  assert.equal(scriptToCommand('yarn', 'preview'), 'yarn run preview')
  assert.equal(scriptToCommand('bun', 'test'), 'bun run test')
})

test('defaultGroupName 优先用包的 name，没有才退回目录名', () => {
  assert.equal(defaultGroupName({ name: 'my-app', dir: 'C:/x/y' }), 'my-app')
  assert.equal(defaultGroupName({ name: undefined, dir: join('C:', 'x', 'my-app') }), 'my-app')
  assert.equal(defaultGroupName({ name: '   ', dir: join('C:', 'x', 'fallback') }), 'fallback')
})
