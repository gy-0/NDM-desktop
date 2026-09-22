import assert from 'node:assert/strict'
import test from 'node:test'
import { needsSourceRecovery, recoveryPage, taskRecoveryMessage } from '../src/renderer/src/lib/taskRecovery.ts'

test('recovery never opens a resource URL as if it were a source webpage', () => {
  const task = { status: 'error', url: 'https://cdn.example/file?secret=fixture', diagnostic: { primaryAction: 'renew' } }
  assert.equal(recoveryPage(task), null)
  assert.match(taskRecoveryMessage(task), /没有保存来源网页/)
  assert.equal(recoveryPage({ ...task, pageURL: 'file:///etc/passwd' }), null)
  assert.equal(recoveryPage({ ...task, pageURL: 'https://user:secret@example.com/' }), null)
  assert.equal(recoveryPage({ ...task, pageURL: 'https://example.com/watch' }), 'https://example.com/watch')
})

test('page-backed downloads re-read their saved source and keep account guidance', () => {
  const task = { status: 'error', linkType: 'ytdlp', url: 'https://example.com/watch', diagnostic: { primaryAction: 'openPage' } }
  assert.equal(recoveryPage(task), task.url)
  assert.match(taskRecoveryMessage(task), /原浏览器账号/)
  assert.equal(needsSourceRecovery(task), true)
  assert.equal(needsSourceRecovery({ ...task, status: 'paused' }), false)
  assert.equal(needsSourceRecovery({ ...task, diagnostic: { primaryAction: 'retry' } }), false)
})
