import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

for (const succeeds of [true, false]) {
  test(`persisted browser session resumes when cookie export ${succeeds ? 'succeeds' : 'fails'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ndm-cookie-test-'))
    try {
      const url = 'https://example.test/file.zip'
      await writeFile(join(root, 'state.json'), JSON.stringify({tasks: [{
        id: 1, url, filename: 'file.zip', folderPath: root, status: 'paused',
        cookieBrowser: 'chrome', connections: 4, completedBytes: 0, fileSize: 0
      }]}))
      let exports = 0
      const engine = new WindowsDownloadEngine({stateDirectory: root, defaultDownloadDirectory: root}, {
        onEvent() {}, onStatus() {},
        exportCookies: async (target, browser) => {
          exports++
          assert.equal(target, url)
          assert.equal(browser, 'chrome')
          if (!succeeds) throw new Error('browser unavailable')
          return {ok: true, header: 'session=test-only'}
        }
      })
      await engine.loadState()
      let sent
      engine.rpc.call = async (method, args) => {
        assert.equal(method, 'addUri')
        sent = args[1]
        return 'test-gid'
      }
      assert.equal((await engine.request('resume', {taskID: 1})).ok, true)
      assert.equal(exports, 1)
      assert.deepEqual(sent.header, succeeds ? ['Cookie: session=test-only'] : undefined)
      const saved = await readFile(join(root, 'state.json'), 'utf8')
      assert.equal(JSON.parse(saved).tasks[0].cookieBrowser, 'chrome')
      assert.equal(saved.includes('session=test-only'), false)
      assert.equal(JSON.parse(saved).tasks[0].headers, undefined)
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
}
