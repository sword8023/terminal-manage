import test from 'node:test'
import assert from 'node:assert/strict'

import { formatBytes } from './bytes.ts'

test('formatBytes：不足 1 KB 时显示整数字节', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1023), '1023 B')
})

test('formatBytes：按 1024 进制进位', () => {
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1 MB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5 GB')
})

test('formatBytes：真实的安装包大小（与资源管理器显示一致）', () => {
  // dist/Terminal-Manage-0.1.0-setup.exe 的字节数：111457653 / 1024² = 106.29…
  // 资源管理器显示的就是 106 MB，不显示小数
  assert.equal(formatBytes(111_457_653), '106 MB')
})

test('formatBytes：不足 100 时保留一位小数', () => {
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB')
  assert.equal(formatBytes(99.5 * 1024 * 1024), '99.5 MB')
})

test('formatBytes：超过 100 就取整，避免数字宽度抖动', () => {
  assert.equal(formatBytes(100.5 * 1024), '101 KB')
  assert.equal(formatBytes(999 * 1024 * 1024), '999 MB')
})

test('formatBytes：没有意义的输入返回空串（界面据此不显示单位）', () => {
  assert.equal(formatBytes(undefined), '')
  assert.equal(formatBytes(null), '')
  assert.equal(formatBytes(-1), '')
  assert.equal(formatBytes(Number.NaN), '')
})
