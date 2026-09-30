/**
 * 用真实的项目目录跑一遍「导入目录」的核心逻辑（PackageReader），
 * 把应用会读到的 scripts / workspaces 打出来。不经过 Electron 与 IPC。
 *
 *   node spike/inspect.ts spike/fixture
 *
 * 存在的意义：PackageReader.test.ts 用的是自己造的临时夹具，
 * 只能证明「按我理解的格式能读对」，证明不了「按这些真实项目的格式能读对」。
 */
import { readPackageInfo, defaultGroupName, scriptToCommand } from '../src/main/core/PackageReader.ts'

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node spike/inspect.ts <项目目录>')
  process.exit(2)
}

const info = await readPackageInfo(dir)

console.log(`目录          : ${info.dir}`)
console.log(`找到 package  : ${info.found}`)
console.log(`包名          : ${info.name ?? '-'}`)
console.log(`包管理器      : ${info.packageManager}`)
console.log(`默认分组名    : ${defaultGroupName(info)}`)
console.log(`警告          : ${info.warnings.length ? info.warnings.join(' | ') : '无'}`)

console.log(`scripts (${info.scripts.length}):`)
for (const s of info.scripts) {
  console.log(`  - ${s.key.padEnd(14)} => ${scriptToCommand(info.packageManager, s.key)}     [${s.value}]`)
}

console.log(`workspaces (${info.workspaces.length}):`)
for (const w of info.workspaces) {
  console.log(`  - ${w.name} @ ${w.dir}  scripts=${w.scripts.length}`)
}
