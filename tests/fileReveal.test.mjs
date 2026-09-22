import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revealDownloadedFile } from '../src/main/fileReveal.ts'
import { runFileDeliveryAction } from '../src/renderer/src/lib/fileDelivery.ts'

test('a removed file opens its parent but reports that the file was not found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-reveal-'))
  try {
    const file = join(root, 'download.txt'), shown = [], opened = []
    const dependencies = { exists: existsSync, installedPath: async () => null, showItem: path => shown.push(path), openPath: async path => { opened.push(path); return '' } }
    await writeFile(file, 'fixture')
    assert.equal(await revealDownloadedFile(file, dependencies), true)
    assert.deepEqual(shown, [file]); assert.deepEqual(opened, [])
    await unlink(file)
    const result = await revealDownloadedFile(file, dependencies)
    assert.equal(result, 'parent-opened'); assert.deepEqual(opened, [root])
    assert.equal(await runFileDeliveryAction('reveal', async () => result), '文件已不在原位置，已打开原保存文件夹')
    assert.match(await runFileDeliveryAction('open', () => '文件不存在'), /可能已移动或删除/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing folders and OS failures cannot return successful reveal', async () => {
  const dependencies = { exists: () => false, installedPath: async () => null, showItem: () => assert.fail('unexpected reveal'), openPath: async () => 'private path failure' }
  const file = join(tmpdir(), 'missing', 'download.txt')
  assert.equal(await revealDownloadedFile(file, dependencies), false)
  assert.equal(await revealDownloadedFile(file, { ...dependencies, exists: path => path !== file }), false)
  assert.equal(await revealDownloadedFile(file, { ...dependencies, installedPath: async () => { throw new Error('private') } }), false)
  assert.equal(await revealDownloadedFile('relative.txt', dependencies), false)
  assert.equal(await revealDownloadedFile(null, dependencies), false)
})

test('an existing installation receipt target remains a valid reveal destination', async () => {
  const file = join(tmpdir(), 'source.dmg'), installed = join(tmpdir(), 'Installed.app'), shown = []
  assert.equal(await revealDownloadedFile(file, { exists: path => path === installed, installedPath: async () => installed,
    showItem: path => shown.push(path), openPath: async () => assert.fail('unexpected parent fallback') }), true)
  assert.deepEqual(shown, [installed])
})
