import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { consumePendingRestart, pendingRestartPath, writePendingRestart } from './pendingRestart.ts'

/** 每个用例一个独立临时目录：升级意图文件的全部行为都发生在磁盘上 */
async function makeRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tm-pending-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('pendingRestartPath 拼在 userData 下', () => {
  assert.equal(pendingRestartPath('C:\\data'), join('C:\\data', 'pending-restart.json'))
})

test('写入后能读回，并且读完即删', async (t) => {
  const root = await makeRoot(t)
  const file = pendingRestartPath(root)

  await writePendingRestart(file, { restartMarked: true, fromVersion: '0.1.0', at: 1_700_000 })

  assert.deepEqual(await consumePendingRestart(file), {
    restartMarked: true,
    fromVersion: '0.1.0',
    at: 1_700_000,
  })
  // 第二次必须是 null：这个意图只能用一次。留着它，下个月启动还会照它拉命令
  assert.equal(await consumePendingRestart(file), null)
})

test('restartMarked 为 false 的内容也照样消费掉', async (t) => {
  const root = await makeRoot(t)
  const file = pendingRestartPath(root)

  await writePendingRestart(file, { restartMarked: false, fromVersion: '0.1.0', at: 1 })

  const intent = await consumePendingRestart(file)
  assert.equal(intent?.restartMarked, false)
  // 「不拉起」同样是已经执行过的意图，文件不该留下
  await assert.rejects(readFile(file, 'utf8'))
})

test('文件不存在时返回 null', async (t) => {
  const root = await makeRoot(t)
  assert.equal(await consumePendingRestart(pendingRestartPath(root)), null)
})

test('目录不存在时写入会自动建目录（首次升级就是在空 userData 上写的）', async (t) => {
  const root = await makeRoot(t)
  const file = join(root, 'nested', 'deep', 'pending-restart.json')

  await writePendingRestart(file, { restartMarked: true, fromVersion: '0.1.0', at: 7 })
  assert.equal((await consumePendingRestart(file))?.at, 7)
})

test('写了一半的 JSON 当作没升级过，并且文件被删掉', async (t) => {
  const root = await makeRoot(t)
  const file = pendingRestartPath(root)
  // app.exit(0) 正好落在写入中间时，磁盘上就是这样的内容
  await writeFile(file, '{"restartMarked":tr', 'utf8')

  assert.equal(await consumePendingRestart(file), null)
  await assert.rejects(readFile(file, 'utf8'))
})

test('restartMarked 不是布尔值时不下判断（宁可什么都不拉起）', async (t) => {
  const root = await makeRoot(t)
  const file = pendingRestartPath(root)
  await writeFile(file, JSON.stringify({ restartMarked: 'true', fromVersion: '0.1.0' }), 'utf8')

  assert.equal(await consumePendingRestart(file), null)
})

test('缺字段时补默认值，不影响 restartMarked 的判断', async (t) => {
  const root = await makeRoot(t)
  const file = pendingRestartPath(root)
  await writeFile(file, JSON.stringify({ restartMarked: true }), 'utf8')

  assert.deepEqual(await consumePendingRestart(file), {
    restartMarked: true,
    fromVersion: '',
    at: 0,
  })
})
