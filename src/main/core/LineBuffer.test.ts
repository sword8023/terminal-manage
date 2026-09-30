/**
 * LineBuffer 单元测试。
 *
 * 用 Node 内置的 node:test + node:assert，零额外依赖。
 * Node 24 默认支持直接运行 .ts（类型擦除），因此无需构建步骤。
 *
 * 运行：node --test src/main/core/LineBuffer.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineBuffer } from './LineBuffer.ts'

test('普通换行 → append', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push('line1\nline2\n'), [
    { type: 'append', text: 'line1' },
    { type: 'append', text: 'line2' },
  ])
  assert.deepEqual(lb.committed, ['line1', 'line2'])
  assert.equal(lb.active, '')
})

test('Windows 的 \\r\\n 只算一次换行，且不残留 \\r', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push('abc\r\ndef'), [
    { type: 'append', text: 'abc' },
  ])
  assert.deepEqual(lb.committed, ['abc'])
  assert.equal(lb.active, 'def')
})

test('\\r 覆写当前行 → replace', () => {
  const lb = new LineBuffer()
  const events = lb.push('progress 3/8\rprogress 4/8')
  assert.deepEqual(events, [{ type: 'replace', text: 'progress 4/8' }])
  assert.equal(lb.active, 'progress 4/8')
  assert.deepEqual(lb.committed, [])
})

test('多次 \\r 只保留最后一个', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push('a\rb\rc'), [{ type: 'replace', text: 'c' }])
  assert.equal(lb.active, 'c')
})

test('\\r 覆写后接 \\n → 提交被覆写后的内容', () => {
  const lb = new LineBuffer()
  const events = lb.push('3/8\r4/8\n')
  assert.deepEqual(events, [{ type: 'append', text: '4/8' }])
  assert.deepEqual(lb.committed, ['4/8'])
})

test('★ chunk 边界切在 \\r 和 \\n 之间 → 不得误判为覆写', () => {
  const lb = new LineBuffer()
  // 第一块以 \r 结尾，此时还不能判定
  assert.deepEqual(lb.push('abc\r'), [])
  assert.equal(lb.active, 'abc')
  // 第二块以 \n 开头 → 应识别为 \r\n，提交 "abc"
  assert.deepEqual(lb.push('\ndef'), [{ type: 'append', text: 'abc' }])
  assert.deepEqual(lb.committed, ['abc'])
  assert.equal(lb.active, 'def')
})

test('★ chunk 边界切在 \\r 后，但下一块不是 \\n → 判定为覆写', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push('abc\r'), [])
  assert.deepEqual(lb.push('def'), [{ type: 'replace', text: 'def' }])
  assert.equal(lb.active, 'def')
  assert.deepEqual(lb.committed, [])
})

test('无换行的残留内容不产生事件', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push('abc'), [])
  assert.equal(lb.active, 'abc')
})

test('flush 提交未换行的尾部内容', () => {
  const lb = new LineBuffer()
  lb.push('tail')
  assert.deepEqual(lb.flush(), [{ type: 'append', text: 'tail' }])
  assert.deepEqual(lb.committed, ['tail'])
})

test('空 chunk 不产生事件', () => {
  const lb = new LineBuffer()
  assert.deepEqual(lb.push(''), [])
})

test('跨多块累积同一行', () => {
  const lb = new LineBuffer()
  lb.push('he')
  lb.push('ll')
  lb.push('o\n')
  assert.deepEqual(lb.committed, ['hello'])
})

test('真实场景：vite 风格进度条序列', () => {
  const lb = new LineBuffer()
  const chunks = [
    '  VITE v5.0.0  ready in 123 ms\n',
    '  ➜  Local:   http://localhost:5173/\n',
    '\r  rendering chunks (1/3)...',
    '\r  rendering chunks (2/3)...',
    '\r  rendering chunks (3/3)...',
    '\r                              \r',
    '  ✓ built in 456ms\n',
  ]
  const all = chunks.flatMap((c) => lb.push(c))
  assert.deepEqual(lb.committed, [
    '  VITE v5.0.0  ready in 123 ms',
    '  ➜  Local:   http://localhost:5173/',
    '  ✓ built in 456ms',
  ])
  // 进度条不应留下任何已提交的垃圾行
  assert.equal(all.filter((e) => e.type === 'append').length, 3)
})

test('★ 保留行数有上限，不会无限增长', () => {
  const lb = new LineBuffer(100)
  // 写入远超容量的行数
  for (let i = 0; i < 5000; i++) lb.push(`line ${i}\n`)
  // 摊还裁剪允许短暂超出，但必须远小于写入总量
  assert.ok(lb.committed.length < 500, `实际保留 ${lb.committed.length} 行`)
  // 保留的必须是最近的若干行
  const snapshot = lb.snapshot()
  assert.equal(snapshot[snapshot.length - 1], 'line 4999')
  // snapshot 是副本，改动不影响内部状态
  snapshot.push('污染')
  assert.notEqual(lb.committed[lb.committed.length - 1], '污染')
})

test('clear 重置全部状态', () => {
  const lb = new LineBuffer()
  lb.push('abc\n')
  lb.push('pending')
  lb.clear()
  assert.deepEqual(lb.committed, [])
  assert.equal(lb.active, '')
})
