import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_INSTALLER_ARGS, installerArgsFor, parseInstallerArgsOverride } from './installer.ts'

test('installerArgsFor：开发态（没有安装目录）只给静默 + 自动拉起', () => {
  assert.deepEqual(installerArgsFor(undefined), ['/S', '--force-run'])
})

test('installerArgsFor：给了安装目录就把 /D 追加在最后', () => {
  const args = installerArgsFor('C:\\Apps\\Terminal Manage')
  assert.deepEqual(args, ['/S', '--force-run', '/D=C:\\Apps\\Terminal Manage'])
  assert.equal(args.at(-1), '/D=C:\\Apps\\Terminal Manage')
})

test('installerArgsFor：任何参数里都不能出现引号（NSIS 会把引号当成目录名的一部分）', () => {
  const args = installerArgsFor('C:\\Program Files\\Terminal Manage')
  for (const arg of args) {
    assert.ok(!arg.includes('"'), `参数不该带引号：${arg}`)
    assert.ok(!arg.startsWith('"') && !arg.endsWith('"'), `参数不该被引号包住：${arg}`)
  }
})

test('installerArgsFor：含空格的目录保持成一个参数（靠 windowsVerbatimArguments 原样传下去）', () => {
  const args = installerArgsFor('C:\\a b')
  assert.equal(args.length, 3)
  assert.equal(args[2], '/D=C:\\a b')
})

test('installerArgsFor：不改动默认参数常量', () => {
  const before = [...DEFAULT_INSTALLER_ARGS]
  installerArgsFor('C:\\Apps')
  assert.deepEqual(DEFAULT_INSTALLER_ARGS, before)
  assert.equal(DEFAULT_INSTALLER_ARGS.length, 2)
})

test('parseInstallerArgsOverride：没设或只设了空白就是没有覆盖', () => {
  assert.equal(parseInstallerArgsOverride(undefined), undefined)
  assert.equal(parseInstallerArgsOverride(''), undefined)
  assert.equal(parseInstallerArgsOverride('   '), undefined)
})

test('parseInstallerArgsOverride：按空白切分，连续空白不会切出空参数', () => {
  assert.deepEqual(parseInstallerArgsOverride('/S'), ['/S'])
  assert.deepEqual(parseInstallerArgsOverride('  /S   /D=C:\\Apps  '), ['/S', '/D=C:\\Apps'])
})
