import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterCommands, nextCommandId } from '../src/renderer/src/lib/commandSearch.ts'

const commands = [
  { id: 'preview', label: '快速预览', detail: '预览当前所选文件', keywords: ['quick look', 'preview', 'space'] },
  { id: 'copy', label: '复制下载链接', keywords: ['复制链接', 'copy url', 'link'] },
  { id: 'open', label: '打开文件', disabled: true },
  { id: 'settings', label: '设置', keywords: ['settings', 'preferences'] }
]

test('command search accepts Chinese names, useful aliases and case-insensitive English', () => {
  assert.deepEqual(filterCommands(commands, '预览').map(item => item.id), ['preview'])
  assert.deepEqual(filterCommands(commands, '复制链接').map(item => item.id), ['copy'])
  assert.deepEqual(filterCommands(commands, 'PREFERENCES').map(item => item.id), ['settings'])
  assert.deepEqual(filterCommands(commands, 'ＣＯＰＹ').map(item => item.id), ['copy'])
})

test('each search word must describe the same command, without changing caller order', () => {
  assert.deepEqual(filterCommands(commands, 'quick 所选').map(item => item.id), ['preview'])
  assert.deepEqual(filterCommands(commands, 'copy settings'), [])
  assert.deepEqual(filterCommands(commands, ' \t '), commands)
  assert.deepEqual(filterCommands(commands, 'does not exist'), [])
})

test('natural Chinese shorthand can omit modifiers without changing character order', () => {
  assert.deepEqual(filterCommands([{ id: 'copy', label: '复制下载链接' }], '复制链接').map(item => item.id), ['copy'])
  assert.deepEqual(filterCommands([{ id: 'delete', label: '删除所选任务' }], '删除任务').map(item => item.id), ['delete'])
  assert.deepEqual(filterCommands([{ id: 'copy', label: '复制下载链接' }], '链接复制'), [])
  assert.deepEqual(filterCommands([{ id: 'preview', label: 'preview' }], 'pvw'), [])
})

test('keyboard navigation skips unavailable commands and wraps through visible results', () => {
  assert.equal(nextCommandId(commands, 'copy', 1), 'settings')
  assert.equal(nextCommandId(commands, 'settings', 1), 'preview')
  assert.equal(nextCommandId(commands, 'preview', -1), 'settings')
  assert.equal(nextCommandId(commands, null, 1), 'preview')
  assert.equal(nextCommandId(commands, 'removed', -1), 'settings')
  assert.equal(nextCommandId(filterCommands(commands, 'copy'), 'copy', 1), 'copy')
})

test('no matches and unavailable-only results have no executable keyboard selection', () => {
  assert.equal(nextCommandId([], null, 1), null)
  assert.equal(nextCommandId([{ id: 'open', label: '打开', disabled: true }], null, -1), null)
})
