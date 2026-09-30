import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorChain,
  childrenOf,
  collectCommands,
  countCommands,
  descendantIds,
  findNode,
  isDescendantOf,
  moveNode,
  nextOrder,
  normalizeOrders,
  normalizeTree,
  removeWithDescendants,
  resolvePath,
} from './tree.ts'
import type { CommandNode, GroupNode, TreeNode } from '@shared/types'

// ---------------------------------------------------------------------------
// 构造夹具
// ---------------------------------------------------------------------------

function g(id: string, parentId: string | null = null, order = 0, path?: string): GroupNode {
  return {
    id,
    kind: 'group',
    parentId,
    order,
    name: id,
    path,
    expanded: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function c(
  id: string,
  parentId: string | null = null,
  order = 0,
  extra: Partial<CommandNode> = {},
): CommandNode {
  return {
    id,
    kind: 'command',
    parentId,
    order,
    name: id,
    command: 'npm run dev',
    autoDiscovered: true,
    hidden: false,
    marked: false,
    shell: 'cmd',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

/**
 *   root
 *   ├── shop        (path: C:/shop)
 *   │   ├── web     (path: C:/shop/packages/web)
 *   │   │   ├── dev
 *   │   │   └── build  (hidden)
 *   │   └── dev
 *   └── loose       (无 path)
 *       └── orphan
 */
function fixture(): TreeNode[] {
  return [
    g('root', null, 0),
    g('shop', 'root', 0, 'C:/shop'),
    g('web', 'shop', 0, 'C:/shop/packages/web'),
    c('web-dev', 'web', 0, { name: 'dev' }),
    c('web-build', 'web', 1, { name: 'build', hidden: true }),
    c('shop-dev', 'shop', 1, { name: 'dev' }),
    g('loose', 'root', 1),
    c('orphan', 'loose', 0),
  ]
}

// ---------------------------------------------------------------------------

test('childrenOf 按 order 升序，且只看直接子节点', () => {
  const nodes = fixture()
  assert.deepEqual(
    childrenOf(nodes, 'root').map((n) => n.id),
    ['shop', 'loose'],
  )
  assert.deepEqual(
    childrenOf(nodes, 'web').map((n) => n.id),
    ['web-dev', 'web-build'],
  )
  // 后代不会被误当成直接子节点
  assert.deepEqual(
    childrenOf(nodes, 'root').filter((n) => n.id === 'web'),
    [],
  )
})

test('childrenOf 对 null 返回根级节点', () => {
  assert.deepEqual(
    childrenOf(fixture(), null).map((n) => n.id),
    ['root'],
  )
})

test('descendantIds 递归收集全部后代，且不含自身', () => {
  const nodes = fixture()
  assert.deepEqual(descendantIds(nodes, 'web').sort(), ['web-build', 'web-dev'])
  assert.deepEqual(descendantIds(nodes, 'shop').sort(), ['shop-dev', 'web', 'web-build', 'web-dev'])
  assert.deepEqual(descendantIds(nodes, 'shop-dev'), [])
})

test('descendantIds 遇到自指的环会收敛而不是死循环', () => {
  const nodes: TreeNode[] = [g('a', 'a', 0), g('b', 'a', 0)]
  // a 自己指向自己：因为它已经被记进 seen，不会再次入队，遍历能正常结束。
  // 注意后代集合不含自身，所以结果里只有 b。
  assert.deepEqual(descendantIds(nodes, 'a'), ['b'])
})

test('isDescendantOf 对自身也返回 true', () => {
  const nodes = fixture()
  assert.equal(isDescendantOf(nodes, 'web', 'shop'), true)
  assert.equal(isDescendantOf(nodes, 'shop', 'shop'), true)
  assert.equal(isDescendantOf(nodes, 'shop', 'web'), false)
  assert.equal(isDescendantOf(nodes, 'loose', 'shop'), false)
})

test('resolvePath 取自身或最近祖先分组绑定的目录', () => {
  const nodes = fixture()
  // 命令自己没有 path，继承最近的祖先
  assert.equal(resolvePath(nodes, 'web-dev'), 'C:/shop/packages/web')
  assert.equal(resolvePath(nodes, 'shop-dev'), 'C:/shop')
  // 分组自身有 path 时直接用自己
  assert.equal(resolvePath(nodes, 'web'), 'C:/shop/packages/web')
  // 中间隔着没有 path 的分组也能一路向上找到
  assert.equal(resolvePath(nodes, 'loose'), undefined)
  assert.equal(resolvePath(nodes, 'orphan'), undefined)
})

test('nextOrder 返回同级末尾序号的下一个值', () => {
  const nodes = fixture()
  assert.equal(nextOrder(nodes, 'web'), 2)
  assert.equal(nextOrder(nodes, 'root'), 2)
  assert.equal(nextOrder(nodes, 'loose'), 1)
})

test('ancestorChain 从父到根排列，且不含自身', () => {
  const nodes = fixture()
  assert.deepEqual(
    ancestorChain(nodes, 'web-dev').map((n) => n.id),
    ['root', 'shop', 'web'],
  )
  assert.deepEqual(ancestorChain(nodes, 'root'), [])
})

test('collectCommands 默认递归且排除 hidden', () => {
  const nodes = fixture()
  assert.deepEqual(
    collectCommands(nodes, 'shop').map((n) => n.id),
    ['web-dev', 'shop-dev'],
  )
})

test('collectCommands 的 deep:false 只看直接子节点', () => {
  const nodes = fixture()
  assert.deepEqual(
    collectCommands(nodes, 'shop', { deep: false }).map((n) => n.id),
    ['shop-dev'],
  )
})

test('collectCommands 的 includeHidden 会把置灰命令也带上', () => {
  const nodes = fixture()
  assert.deepEqual(
    collectCommands(nodes, 'shop', { includeHidden: true }).map((n) => n.id),
    ['web-dev', 'web-build', 'shop-dev'],
  )
})

test('collectCommands 传 null 时覆盖整棵树', () => {
  const nodes = fixture()
  assert.deepEqual(
    collectCommands(nodes, null).map((n) => n.id),
    ['web-dev', 'shop-dev', 'orphan'],
  )
})

test('collectCommands 选中命令自身时返回它自己', () => {
  const nodes = fixture()
  assert.deepEqual(
    collectCommands(nodes, 'shop-dev').map((n) => n.id),
    ['shop-dev'],
  )
  // 但它被隐藏时默认拿不到
  assert.deepEqual(collectCommands(nodes, 'web-build'), [])
  assert.deepEqual(
    collectCommands(nodes, 'web-build', { includeHidden: true }).map((n) => n.id),
    ['web-build'],
  )
})

test('countCommands 给出「运行中 / 总数」', () => {
  const nodes = fixture()
  const active = new Set(['web-dev'])
  assert.deepEqual(countCommands(nodes, 'shop', (id) => active.has(id)), {
    active: 1,
    total: 2,
  })
})

test('moveNode 在同一个父节点内重排并重写 order', () => {
  const nodes = fixture()
  moveNode(nodes, { id: 'loose', newParentId: 'root', index: 0 })
  assert.deepEqual(
    childrenOf(nodes, 'root').map((n) => n.id),
    ['loose', 'shop'],
  )
  assert.deepEqual(
    childrenOf(nodes, 'root').map((n) => n.order),
    [0, 1],
  )
})

test('moveNode 换父节点后原父下的 order 会被压实', () => {
  const nodes = fixture()
  moveNode(nodes, { id: 'web', newParentId: 'root', index: 2 })
  assert.equal(findNode(nodes, 'web')?.parentId, 'root')
  // shop 只剩 shop-dev 一个直接子节点，order 归零
  assert.deepEqual(
    childrenOf(nodes, 'shop').map((n) => [n.id, n.order]),
    [['shop-dev', 0]],
  )
  // web 下面的命令跟着一起搬走了
  assert.equal(resolvePath(nodes, 'web-dev'), 'C:/shop/packages/web')
})

test('moveNode 拒绝把分组移进自己的子树', () => {
  const nodes = fixture()
  assert.throws(
    () => moveNode(nodes, { id: 'shop', newParentId: 'web', index: 0 }),
    /不能把一个分组移动到它自己的子分组里/,
  )
  // 拒绝之后树必须保持原样，不能留半截修改
  assert.equal(findNode(nodes, 'shop')?.parentId, 'root')
})

test('moveNode 拒绝把节点挂到命令下面', () => {
  const nodes = fixture()
  assert.throws(
    () => moveNode(nodes, { id: 'loose', newParentId: 'shop-dev', index: 0 }),
    /命令不能作为容器/,
  )
})

test('moveNode 的目标下标越界时被夹到合法范围', () => {
  const nodes = fixture()
  moveNode(nodes, { id: 'shop', newParentId: 'root', index: 999 })
  assert.deepEqual(
    childrenOf(nodes, 'root').map((n) => n.id),
    ['loose', 'shop'],
  )
})

test('removeWithDescendants 连带删除整棵子树并压实序号', () => {
  const nodes = fixture()
  const removed = removeWithDescendants(nodes, 'shop')
  assert.deepEqual(removed.sort(), ['shop', 'shop-dev', 'web', 'web-build', 'web-dev'])
  assert.equal(findNode(nodes, 'shop'), undefined)
  assert.equal(findNode(nodes, 'web-dev'), undefined)
  // root 下只剩 loose，order 归零
  assert.deepEqual(
    childrenOf(nodes, 'root').map((n) => [n.id, n.order]),
    [['loose', 0]],
  )
})

test('normalizeOrders 把紧凑序号重排成 0..n-1', () => {
  const nodes: TreeNode[] = [c('a', null, 7), c('b', null, 3), c('c', null, 99)]
  normalizeOrders(nodes, null)
  assert.deepEqual(
    childrenOf(nodes, null).map((n) => [n.id, n.order]),
    [
      ['b', 0],
      ['a', 1],
      ['c', 2],
    ],
  )
})

// ---------------------------------------------------------------------------
// normalizeTree —— 磁盘内容清洗
// ---------------------------------------------------------------------------

test('normalizeTree 丢弃 kind 非法与缺 id 的条目并记警告', () => {
  const warnings: string[] = []
  const nodes = normalizeTree(
    [
      { id: 'a', kind: 'group' },
      { id: 'b', kind: 'wat' },
      { kind: 'group' },
      'not an object',
      null,
    ],
    warnings,
  )
  assert.deepEqual(nodes.map((n) => n.id), ['a'])
  assert.equal(warnings.length, 2)
})

test('normalizeTree 丢弃重复 id 的后一个', () => {
  const warnings: string[] = []
  const nodes = normalizeTree(
    [
      { id: 'a', kind: 'group', name: '先来的' },
      { id: 'a', kind: 'group', name: '后来的' },
    ],
    warnings,
  )
  assert.equal(nodes.length, 1)
  assert.equal((nodes[0] as GroupNode).name, '先来的')
  assert.equal(warnings.length, 1)
})

test('normalizeTree 补齐命令节点的缺省值', () => {
  const nodes = normalizeTree([{ id: 'x', kind: 'command' }], [])
  const node = nodes[0] as CommandNode
  assert.equal(node.name, '未命名命令')
  assert.equal(node.command, 'npm run dev')
  assert.equal(node.shell, 'cmd')
  assert.equal(node.hidden, false)
  assert.equal(node.autoDiscovered, false)
  assert.equal(node.parentId, null)
})

test('normalizeTree 忽略非法 shell 并回落到 cmd', () => {
  const nodes = normalizeTree([{ id: 'x', kind: 'command', shell: 'bash' }], [])
  assert.equal((nodes[0] as CommandNode).shell, 'cmd')
})

test('normalizeTree 把父节点不存在的节点提到根级', () => {
  const warnings: string[] = []
  const nodes = normalizeTree([{ id: 'a', kind: 'group', parentId: 'ghost' }], warnings)
  assert.equal(nodes[0]?.parentId, null)
  assert.match(warnings[0] ?? '', /父节点不存在/)
})

test('normalizeTree 把挂在命令下面的节点提到根级', () => {
  const warnings: string[] = []
  const nodes = normalizeTree(
    [
      { id: 'cmd', kind: 'command' },
      { id: 'kid', kind: 'group', parentId: 'cmd' },
    ],
    warnings,
  )
  assert.equal(nodes.find((n) => n.id === 'kid')?.parentId, null)
  assert.match(warnings.join('|'), /挂在一条命令下面/)
})

test('normalizeTree 打破父链上的环，且两个节点都保留', () => {
  const warnings: string[] = []
  const nodes = normalizeTree(
    [
      { id: 'a', kind: 'group', parentId: 'b' },
      { id: 'b', kind: 'group', parentId: 'a' },
    ],
    warnings,
  )
  assert.equal(nodes.length, 2)
  assert.equal(warnings.filter((w) => w.includes('成环')).length, 1)
  // 打破之后至少有一个回到了根级，整棵树重新可达
  assert.ok(nodes.some((n) => n.parentId === null))
})

test('normalizeTree 输入不是数组时返回空树而不是抛错', () => {
  const warnings: string[] = []
  assert.deepEqual(normalizeTree({ nodes: [] }, warnings), [])
  assert.deepEqual(normalizeTree(null, warnings), [])
  assert.deepEqual(normalizeTree('nope', warnings), [])
})

test('normalizeTree 会把同级节点的 order 重新压实', () => {
  const nodes = normalizeTree(
    [
      { id: 'a', kind: 'group', order: 50 },
      { id: 'b', kind: 'group', order: 10 },
    ],
    [],
  )
  assert.deepEqual(
    childrenOf(nodes, null).map((n) => [n.id, n.order]),
    [
      ['b', 0],
      ['a', 1],
    ],
  )
})
