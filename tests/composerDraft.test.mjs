import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ComposerDraftController, composerDraftStatePath } from '../src/main/composerDraft.ts'

const key = randomBytes(32)
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString(plaintext) {
    const iv = randomBytes(12)
    const encryptor = createCipheriv('aes-256-gcm', key, iv)
    const bytes = Buffer.concat([encryptor.update(plaintext, 'utf8'), encryptor.final()])
    return Buffer.concat([iv, encryptor.getAuthTag(), bytes])
  },
  decryptString(bytes) {
    const decryptor = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decryptor.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decryptor.update(bytes.subarray(28)), decryptor.final()]).toString('utf8')
  }
}
const draft = () => ({
  version: 1, id: 'review-draft', input: 'https://new.example.test/separate.zip',
  items: [{ id: 'item-a', url: 'https://files.example.test/a.zip?signature=A%2Fb%2BC&expires=1900000000', status: 'pending' }],
  destination: { mode: 'explicit', path: '/isolated/user-chosen' },
  connections: { mode: 'explicit', value: 8 }
})
const request = (url = draft().items[0].url) => ({ op: 'add', options: { url, creationKey: randomUUID(), connections: 8, autoStart: false } })
function memory(bytes = null) {
  return { bytes, writes: 0, readError: false, writeError: false,
    read() { if (this.readError) throw new Error('private path denied'); return this.bytes },
    write(value) { if (this.writeError) throw new Error('private path disk full'); this.bytes = Buffer.from(value); this.writes += 1 }
  }
}
const controller = (storage, changes = {}) => new ComposerDraftController({ statePath: '/unused/composer-draft.enc', cipher, storage, now: () => 1000, ...changes })

test('empty load is read-only and storage follows the isolated application directory', async () => {
  const storage = memory()
  assert.deepEqual(await controller(storage).load(), { ok: true, revision: 0, draft: null })
  assert.equal(storage.writes, 0)
  assert.equal(composerDraftStatePath('/user-data', '/isolated-support'), '/isolated-support/composer-draft.enc')
  assert.equal(composerDraftStatePath('/user-data', '  '), '/user-data/composer-draft.enc')
})

test('encrypted atomic save survives a new controller, preserving input separate from review items', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ndm-draft-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = composerDraftStatePath(directory)
  const first = new ComposerDraftController({ statePath, cipher })
  const snapshot = await first.save({ expectedRevision: 0, draft: draft() })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.revision, 1)
  const bytes = readFileSync(statePath)
  for (const secret of ['signature=', 'new.example', '/isolated/user-chosen', 'review-draft']) assert.equal(bytes.includes(Buffer.from(secret)), false)
  assert.deepEqual(await new ComposerDraftController({ statePath, cipher }).load(), snapshot)
  assert.equal(snapshot.draft.items.length, 1)
  assert.equal(snapshot.draft.input, draft().input)
  assert.deepEqual(readdirSync(directory), ['composer-draft.enc'])
  if (process.platform !== 'win32') assert.equal(statSync(statePath).mode & 0o777, 0o600)
})

test('mixed accepted, uncertain, failed and pending states round-trip without turning uncertainty into retry', async () => {
  const storage = memory()
  const value = draft()
  value.items = ['accepted', 'unconfirmed', 'failed', 'pending'].map((status, i) => ({
    id: `item-${i}`, url: `https://files.example.test/${i}.zip`, status,
    ...(status === 'pending' ? {} : { request: request(`https://files.example.test/${i}.zip`) }),
    ...(status === 'accepted' ? { taskID: 42 } : {})
  }))
  const saved = await controller(storage).save({ expectedRevision: 0, draft: value })
  assert.equal(saved.ok, true)
  const loaded = await controller(storage).load()
  assert.deepEqual(loaded, saved)
  assert.deepEqual(loaded.draft.items.map(item => item.status), ['accepted', 'unconfirmed', 'failed', 'pending'])
  assert.equal(loaded.draft.items[0].taskID, 42)
  assert.equal(loaded.draft.items[1].operationID, value.items[1].request.options.creationKey)
  assert.match(loaded.draft.items[1].requestDigest, /^[a-f0-9]{64}$/)
})

test('concurrent same-revision saves serialize, stale saves and discard cannot overwrite newer work', async () => {
  const storage = memory()
  const instance = controller(storage)
  const a = draft(), b = draft()
  b.input = 'https://other.example.test/new.zip'
  const [saved, stale] = await Promise.all([
    instance.save({ expectedRevision: 0, draft: a }),
    instance.save({ expectedRevision: 0, draft: b })
  ])
  assert.equal(saved.ok, true)
  assert.equal(stale.code, 'conflict')
  assert.equal((await instance.discard({ expectedRevision: 0 })).code, 'conflict')
  assert.equal((await instance.load()).draft.input, a.input)
  assert.equal(storage.writes, 1)
})

test('discard commits a tombstone that rejects delayed callbacks after restart', async () => {
  const storage = memory()
  const instance = controller(storage)
  await instance.save({ expectedRevision: 0, draft: draft() })
  assert.deepEqual(await instance.discard({ expectedRevision: 1 }), { ok: true, revision: 2, draft: null })
  const restarted = controller(storage)
  assert.deepEqual(await restarted.load(), { ok: true, revision: 2, draft: null })
  assert.equal((await restarted.save({ expectedRevision: 1, draft: draft() })).code, 'conflict')
  assert.equal((await restarted.save({ expectedRevision: 2, draft: { ...draft(), id: 'new-explicit-review' } })).ok, true)
})

test('only acknowledged writes advance revision; failed replacement and discard preserve the saved draft', async () => {
  const storage = memory()
  const instance = controller(storage)
  const first = await instance.save({ expectedRevision: 0, draft: draft() })
  const bytes = Buffer.from(storage.bytes)
  storage.writeError = true
  const changed = { ...draft(), input: 'changed but not saved' }
  const reply = await instance.save({ expectedRevision: 1, draft: changed })
  assert.equal(reply.code, 'writeFailed')
  assert.equal(reply.revision, 1)
  assert.doesNotMatch(reply.error, /private|disk full/)
  assert.equal((await instance.discard({ expectedRevision: 1 })).code, 'writeFailed')
  assert.deepEqual(storage.bytes, bytes)
  assert.deepEqual(await controller(storage).load(), first)
  storage.writeError = false
  assert.equal((await instance.save({ expectedRevision: 1, draft: changed })).revision, 2)
})

test('ACK observes committed bytes and shutdown drains received writes', async () => {
  const storage = memory()
  const instance = controller(storage)
  const value = draft()
  const saving = instance.save({ expectedRevision: 0, draft: value })
  value.items[0].url = 'https://mutated.example.test/not-sent.zip'
  assert.equal(instance.hasPendingWrites, true)
  const closing = instance.close()
  assert.equal((await instance.discard({ expectedRevision: 1 })).code, 'shuttingDown')
  const saved = await saving
  assert.equal(saved.ok, true)
  assert.equal(storage.writes, 1)
  assert.equal(saved.draft.items[0].url, draft().items[0].url)
  await closing
  assert.equal(instance.hasPendingWrites, false)
  assert.deepEqual(await controller(storage).load(), saved)
})

test('asynchronous encryption stays unacknowledged and shutdown waits until atomic commit', async () => {
  const storage = memory()
  let release
  let reached
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { reached = resolve })
  const instance = controller(storage, { cipher: {
    ...cipher,
    isEncryptionAvailable: async () => true,
    encryptString: async value => { reached(); await gate; return cipher.encryptString(value) }
  } })
  let acknowledged = false, closed = false
  const saving = instance.save({ expectedRevision: 0, draft: draft() }).then(value => { acknowledged = true; return value })
  await entered
  const closing = instance.close().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(acknowledged, false)
  assert.equal(closed, false)
  assert.equal(storage.writes, 0)
  release()
  const saved = await saving
  await closing
  assert.equal(saved.ok, true)
  assert.equal(closed, true)
  assert.equal(storage.writes, 1)
  assert.deepEqual(await controller(storage).load(), saved)
})

test('rejected asynchronous crypto returns a safe failure and does not poison the serial queue', async () => {
  const storage = memory()
  let rejects = true
  const instance = controller(storage, { cipher: { ...cipher, encryptString: async value => {
    if (rejects) throw new Error('private keychain details')
    return cipher.encryptString(value)
  } } })
  assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).code, 'encryptionFailed')
  assert.equal(storage.writes, 0)
  rejects = false
  assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).revision, 1)
})

test('safe storage unavailable or plaintext backend never writes or silently downgrades', async () => {
  for (const changes of [ { isEncryptionAvailable: () => false }, { getSelectedStorageBackend: () => 'basic_text' } ]) {
    const storage = memory()
    const instance = controller(storage, { cipher: { ...cipher, ...changes } })
    assert.equal((await instance.load()).code, 'encryptionUnavailable')
    assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).code, 'encryptionUnavailable')
    assert.equal(storage.bytes, null)
    assert.equal(storage.writes, 0)
  }
})

test('encryption failure keeps the previous ciphertext and can be retried', async () => {
  const storage = memory()
  const first = await controller(storage).save({ expectedRevision: 0, draft: draft() })
  let fails = true
  const instance = controller(storage, { cipher: { ...cipher, encryptString: value => { if (fails) throw new Error('keychain private error'); return cipher.encryptString(value) } } })
  assert.equal((await instance.save({ expectedRevision: 1, draft: draft() })).code, 'encryptionFailed')
  assert.deepEqual(await controller(storage).load(), first)
  fails = false
  assert.equal((await instance.save({ expectedRevision: 1, draft: draft() })).revision, 2)
})

test('locked or changed encryption key preserves the original, then recovers when unlocked', async () => {
  const storage = memory()
  const first = await controller(storage).save({ expectedRevision: 0, draft: draft() })
  const bytes = Buffer.from(storage.bytes)
  let locked = true
  const instance = controller(storage, { cipher: { ...cipher, decryptString: value => { if (locked) throw new Error('locked'); return cipher.decryptString(value) } } })
  assert.equal((await instance.load()).code, 'decryptionFailed')
  assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).code, 'decryptionFailed')
  assert.equal((await instance.discard({ expectedRevision: 0 })).code, 'decryptionFailed')
  assert.deepEqual(storage.bytes, bytes)
  locked = false
  assert.deepEqual(await instance.load(), first)
})

test('read failure never initializes an empty record and retries the original file', async () => {
  const storage = memory()
  const first = await controller(storage).save({ expectedRevision: 0, draft: draft() })
  storage.readError = true
  const instance = controller(storage)
  assert.equal((await instance.load()).code, 'readFailed')
  assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).code, 'readFailed')
  storage.readError = false
  assert.deepEqual(await instance.load(), first)
})

test('corrupt and future-version records survive load, save and discard attempts unchanged', async () => {
  const malformed = Buffer.concat([Buffer.from('NDM-DRAFT-1\n'), cipher.encryptString('{broken')])
  const future = Buffer.concat([Buffer.from('NDM-DRAFT-1\n'), cipher.encryptString(JSON.stringify({ version: 2, revision: 7, draft: null }))])
  const futureEnvelope = Buffer.from('NDM-DRAFT-2\nunknown-ciphertext')
  for (const [bytes, code] of [[Buffer.from('not encrypted json'), 'corrupt'], [malformed, 'corrupt'], [future, 'unsupportedVersion'], [futureEnvelope, 'unsupportedVersion']]) {
    const storage = memory(bytes)
    const instance = controller(storage)
    assert.equal((await instance.load()).code, code)
    assert.equal((await instance.save({ expectedRevision: 0, draft: draft() })).code, code)
    assert.equal((await instance.discard({ expectedRevision: 0 })).code, code)
    assert.deepEqual(storage.bytes, bytes)
    assert.equal(storage.writes, 0)
  }
})

test('request whitelist keeps stable media intent and omits authentication and incidental state', async () => {
  const storage = memory()
  const value = draft()
  value.items[0] = { ...value.items[0], status: 'unconfirmed', rawError: 'private diagnostic', request: {
    op: 'addMedia', options: { ...request().options, folderPath: '', filename: '', formatID: 'v1080+a192', container: 'mkv', collectionScope: 'current', pageTitle: 'Fixture', thumbnailURL: 'https://image.example.test/poster.jpg?sig=A%2FB', subtitleLanguage: 'zh',
      headers: ['Cookie: secret'], cookies: 'secret', cookieBrowser: 'Chrome', browserSessionID: randomUUID(), postData: 'secret', Authorization: 'Bearer secret', password: 'secret' }
  } }
  const result = await controller(storage).save({ expectedRevision: 0, draft: value })
  assert.equal(result.ok, true)
  const item = result.draft.items[0]
  assert.equal(item.request.options.autoStart, false)
  assert.equal(item.request.options.folderPath, '')
  assert.equal(item.request.options.formatID, 'v1080+a192')
  assert.equal(item.request.options.cookieBrowser, 'Chrome')
  assert.equal(item.request.options.browserSessionID, value.items[0].request.options.browserSessionID)
  assert.equal(item.request.options.thumbnailURL, value.items[0].request.options.thumbnailURL)
  const plaintext = cipher.decryptString(storage.bytes.subarray(Buffer.byteLength('NDM-DRAFT-1\n')))
  assert.doesNotMatch(plaintext, /secret|Cookie:|Authorization|postData|password|rawError|private diagnostic/)
  assert.deepEqual(await controller(storage).load(), result)
})

test('inherited options do not freeze defaults; missing request options remain absent', async () => {
  const value = draft()
  value.destination = { mode: 'inherit', path: '/old-default' }
  value.connections = { mode: 'inherit', value: 16 }
  value.items[0].status = 'unconfirmed'
  value.items[0].request = { op: 'add', options: { url: value.items[0].url, creationKey: randomUUID() } }
  const result = await controller(memory()).save({ expectedRevision: 0, draft: value })
  assert.equal(result.ok, true)
  assert.deepEqual(result.draft.destination, { mode: 'inherit' })
  assert.deepEqual(result.draft.connections, { mode: 'inherit' })
  assert.deepEqual(Object.keys(result.draft.items[0].request.options), ['url', 'creationKey'])
})

test('unsafe credentials, malformed identities and impossible receipts are rejected before writing', async () => {
  const cases = [
    value => { value.items[0].url = 'https://user:password@example.test/private' },
    value => { value.input = 'text ftp://user:password@example.test/private' },
    value => { value.input = 'https://example.test\nAuthorization: Bearer secret' },
    value => { value.items[0].status = 'unconfirmed' },
    value => { value.items[0].status = 'accepted'; value.items[0].request = request() },
    value => { value.items[0].taskID = 8 },
    value => { value.items[0].request = request(); value.items[0].operationID = randomUUID() },
    value => { value.items[0].request = request(); value.items[0].request.options.creationKey = 'not-a-uuid' },
    value => { value.items[0].request = { op: 'addMedia', options: { ...request().options, cookieBrowser: 'chrome', browserSessionID: 'cookie-secret-not-uuid' } } },
    value => { value.items[0].request = { op: 'addMedia', options: { ...request().options, browserSessionID: randomUUID() } } },
    value => { value.items.push({ ...value.items[0] }) },
    value => { value.items[0].request = request(); value.items.push({ ...value.items[0], id: 'other-item' }) },
    value => { value.items[0].request = request(); value.items[0].request.options.collectionScope = 'all' },
    value => { value.connections = { mode: 'explicit', value: 0 } },
    value => { value.input = 'x'.repeat(131073) }
  ]
  for (const change of cases) {
    const storage = memory()
    const value = draft()
    change(value)
    assert.equal((await controller(storage).save({ expectedRevision: 0, draft: value })).code, 'invalid')
    assert.equal(storage.writes, 0)
  }
})

test('external mutation of an ACK does not mutate the controller state', async () => {
  const instance = controller(memory())
  const saved = await instance.save({ expectedRevision: 0, draft: draft() })
  saved.draft.items[0].status = 'accepted'
  assert.equal((await instance.load()).draft.items[0].status, 'pending')
})
