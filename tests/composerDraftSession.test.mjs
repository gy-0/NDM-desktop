import assert from 'node:assert/strict'
import test from 'node:test'
import { ComposerDraftSession } from '../src/renderer/src/lib/composerDraftSession.ts'
import { draftCreationRequest, mergeComposerInput, mergeRecoveredDraft } from '../src/renderer/src/lib/composerBatch.ts'

const draft = input => ({ version: 1, id: 'batch', input, items: [], destination: { mode: 'inherit' }, connections: { mode: 'inherit' } })
function fixture() {
  let saved = null, revision = 0, blocked, failure = false
  const calls = []
  const session = new ComposerDraftSession(async (op, extra) => {
    calls.push({ op, ...extra })
    if (op === 'composerDraftLoad') return { ok: true, revision, draft: saved }
    if (blocked) { const gate = blocked; blocked = null; await gate }
    if (failure) return { ok: false, code: 'writeFailed', error: '清单未能保存' }
    assert.equal(extra.expectedRevision, revision)
    saved = op === 'composerDraftDiscard' ? null : extra.draft
    return { ok: true, revision: ++revision, draft: saved }
  })
  return { session, calls, saved: () => saved, fail: value => { failure = value }, hold: () => { let release; blocked = new Promise(resolve => { release = resolve }); return release } }
}

test('draft updates wait for acknowledged revisions and a slow older write cannot replace new edits', async () => {
  const f = fixture(); await f.session.load()
  const release = f.hold()
  const first = f.session.save(draft('first')), last = f.session.save(draft('latest'))
  assert.equal(f.session.getSnapshot().draft.input, 'latest')
  release(); assert.equal(await first, true); assert.equal(await last, true)
  assert.equal(f.saved().input, 'latest')
  assert.deepEqual(f.calls.filter(call => call.op === 'composerDraftSave').map(call => call.expectedRevision), [0, 1])
})

test('a failed write retains edits, does not advance revision and blocks a successful flush until retry', async () => {
  const f = fixture(); await f.session.load(); f.fail(true)
  assert.equal(await f.session.save(draft('keep this')), false)
  assert.equal(await f.session.flush(), false)
  assert.equal(f.saved(), null)
  assert.equal(f.session.getSnapshot().draft.input, 'keep this')
  f.fail(false); assert.equal(await f.session.flush(), true)
  assert.equal(f.saved().input, 'keep this')
  assert.equal(f.session.getSnapshot().error, '')
})

test('discard follows pending writes and rejects a late callback from the discarded draft', async () => {
  const f = fixture(); await f.session.load(); const release = f.hold()
  const save = f.session.save(draft('old')), clear = f.session.discard()
  assert.equal(await f.session.save(draft('late old callback')), false)
  release(); await save; assert.equal(await clear, true)
  assert.equal(f.saved(), null)
  assert.equal(await f.session.save({ ...draft('new'), id: 'next-batch' }), true)
  assert.equal(f.saved().input, 'new')
})

test('malformed load replies are not treated as an empty saved library', async () => {
  const session = new ComposerDraftSession(async () => ({ ok: true }))
  await assert.rejects(session.load(), /读取/)
  assert.equal(session.getSnapshot().loaded, false)
  assert.equal(await session.flush(), true, 'Unreadable existing data alone must not trap app quit')
})

test('prepared draft requests retain exact signed URLs and browser names without credentials or bodies', () => {
  const request = draftCreationRequest('add', { url: 'https://example.com/a.zip?signature=keep', creationKey: 'key', cookieBrowser: 'chrome', headers: ['Cookie: do-not-store', 'Authorization: secret'], body: 'private', postData: 'private', folderPath: '/test/files' })
  assert.deepEqual(request.options, { url: 'https://example.com/a.zip?signature=keep', creationKey: 'key', cookieBrowser: 'chrome', folderPath: '/test/files' })
})

test('recovered draft preserves unsynced edits, accepted receipts and explicit choices', () => {
  const saved = { ...draft('https://example.com/old'), items: [{ id: 'accepted', url: 'https://example.com/a', status: 'accepted', taskID: 42 }, { id: 'pending', url: 'https://example.com/b', status: 'pending' }], connections: { mode: 'explicit', value: 8 } }
  const edited = { ...draft('https://example.com/new'), items: [{ id: 'duplicate', url: 'https://example.com/a', status: 'pending' }, { id: 'new', url: 'https://example.com/c', status: 'pending' }], destination: { mode: 'explicit', path: '/Design assets' } }
  const recovered = mergeRecoveredDraft(saved, edited)
  assert.deepEqual(recovered.items.map(item => item.id), ['accepted', 'pending', 'new'])
  assert.equal(recovered.input, 'https://example.com/old https://example.com/new')
  assert.deepEqual(recovered.destination, edited.destination)
  assert.deepEqual(recovered.connections, saved.connections)
  assert.equal(mergeComposerInput('https://example.com/a', 'https://example.com/a', 'https://example.com/b'), 'https://example.com/a https://example.com/b')
})
