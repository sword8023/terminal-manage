/**
 * 一次性开发工具：把若干个真实项目目录「导入」成应用配置文件，
 * 方便在没人点鼠标的情况下截图看树与卡片。
 *
 *   node spike/seed.ts '%APPDATA%\terminal-manage\config.json' <项目目录> [<项目目录> ...]
 *
 * 直接写应用自己的 config.json —— 会覆盖现有配置，仅供本地截图用，用完即删。
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { readPackageInfo, defaultGroupName, scriptToCommand } from '../src/main/core/PackageReader.ts'
import type { CommandNode, GroupNode, TreeNode } from '../src/shared/types.ts'

const outPath = process.argv[2]
const projectDirs = process.argv.slice(3)

if (!outPath || projectDirs.length === 0) {
  console.error('用法: node spike/seed.ts <config.json 路径> <项目目录> [<项目目录> ...]')
  process.exit(2)
}

const now = Date.now()
const nodes: TreeNode[] = []

function group(name: string, parentId: string | null, order: number, path?: string): GroupNode {
  return {
    kind: 'group',
    id: randomUUID(),
    parentId,
    order,
    createdAt: now,
    updatedAt: now,
    name,
    path,
    expanded: true,
  }
}

function command(
  name: string,
  parentId: string,
  order: number,
  cmd: string,
  script: string | undefined,
  extra: Partial<CommandNode> = {},
): CommandNode {
  return {
    kind: 'command',
    id: randomUUID(),
    parentId,
    order,
    createdAt: now,
    updatedAt: now,
    name,
    command: cmd,
    script,
    autoDiscovered: false,
    hidden: false,
    marked: false,
    shell: 'cmd',
    ...extra,
  }
}

const root = group('前端项目', null, 0)
nodes.push(root)

let groupOrder = 0
for (const dir of projectDirs) {
  const info = await readPackageInfo(dir)
  const g = group(defaultGroupName(info), root.id, groupOrder++, dir)
  nodes.push(g)

  let order = 0
  for (const s of info.scripts) {
    nodes.push(
      command(s.key, g.id, order++, scriptToCommand(info.packageManager, s.key), s.key, {
        autoDiscovered: true,
        // 顺手演示「隐藏命令」：lint 默认藏起来
        hidden: s.key === 'lint',
        expectedPort: s.key === 'dev' ? 8080 : undefined,
      }),
    )
  }

  // 再塞一条手写的，演示「✎ 手动」来源标记
  nodes.push(
    command('清缓存重启', g.id, 99, 'rd /s /q node_modules\\.vite && npm run dev', undefined, {
      autoDiscovered: false,
    }),
  )
}

const config = { version: 2, nodes, settings: { showHiddenCommands: true } }
writeFileSync(outPath, JSON.stringify(config, null, 2), 'utf-8')

console.log(`已写入 ${outPath}`)
console.log(`节点数 ${nodes.length}：分组 ${nodes.filter((n) => n.kind === 'group').length}、命令 ${nodes.filter((n) => n.kind === 'command').length}`)
