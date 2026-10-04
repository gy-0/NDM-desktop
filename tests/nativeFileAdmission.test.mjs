import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canStartNativeFileDirectly } from '../src/renderer/src/lib/nativeFileAdmission.ts'

test('only native GET file names covered by response protection bypass classification', () => {
  for (const name of ['archive.zip', 'book.PDF', 'installer.dmg', 'startup.bin']) {
    assert.equal(canStartNativeFileDirectly({ url: `https://files.example/${name}?signature=a%2Fb` }, 'darwin'), true)
  }
  const base = { url: 'https://files.example/archive.zip' }
  for (const platform of ['win32', 'linux', undefined]) assert.equal(canStartNativeFileDirectly(base, platform), false)
  for (const extra of [{ cookieBrowser: 'chrome' }, { headers: ['Cookie: fixture=1'] }, { method: 'POST', body: '' }, { browserSessionID: 'relay' }, { filename: 'saved.html' }]) {
    assert.equal(canStartNativeFileDirectly({ ...base, ...extra }, 'darwin'), false)
  }
  for (const url of ['https://files.example/download', 'https://files.example/source.txt', 'https://files.example/model.gguf', 'https://files.example/archive.zip?filename=login.html', 'https://proxy.example/login?url=https%3A%2F%2Ffiles.example%2Farchive.zip', 'https://youtube.com/watch?v=1', 'https://u:p@files.example/file.zip']) {
    assert.equal(canStartNativeFileDirectly({ url }, 'darwin'), false, url)
  }
})
