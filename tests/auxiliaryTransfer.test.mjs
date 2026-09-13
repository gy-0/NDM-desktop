import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  AuxiliaryCreationController, auxiliaryErrorMessage, auxiliarySelectionRequest, auxiliarySourceLabel,
  normalizeSFTPHostPin, readAuxiliaryCapabilities, readAuxiliarySnapshot, supportsAuxiliaryProtocol, validateAuxiliaryCreate
} from '../src/shared/auxiliaryTransfer.ts'

const pin = `SHA256:${Buffer.alloc(32, 3).toString('base64').replace(/=+$/, '')}`
const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=private-title&tr=https%3A%2F%2Fuser%3Apassword%40tracker.test%2Fannounce%3Ftoken%3Dprivate-query`
const request = (source = { kind: 'magnet', url: magnet }, overrides = {}) => validateAuxiliaryCreate({ creationKey: randomUUID(), source, autoStart: false, ...overrides }, 'posix')

test('ED2K inline sources preserve both upstream forms and reject malformed endpoints', () => {
  const prefix = `ed2k://|file|fixture.bin|1024|${'a'.repeat(32)}|`
  for (const suffix of ['sources,192.168.1.3:4662|/', '/|sources,peer.example.test:4662,10.0.0.2:65535|/']) {
    const url = prefix + suffix
    assert.equal(request({ kind: 'ed2k', url }).source.url, url)
  }
  for (const peers of ['user@host:80', 'host:0', 'host:65536', 'host:abc', '256.0.0.1:80', 'host..test:80', '-host:80', 'host:80/private', Array(33).fill('host:80').join(',')]) {
    assert.throws(() => request({ kind: 'ed2k', url: `${prefix}sources,${peers}|/` }))
  }
})
const snapshot = (overrides = {}) => ({
  taskID: 7, generation: 3, kind: 'bittorrent', phase: 'awaitingSelection', totalBytes: 300, completedBytes: 0,
  downloadSpeed: 0, uploadSpeed: 0, payloadCompleted: false,
  files: [{ index: 1, relativePath: 'folder/a.zip', length: 100, completedLength: 0, selected: true }, { index: 2, relativePath: 'folder/b.zip', length: 200, completedLength: 0, selected: false }], ...overrides
})

 test('valid magnet, ED2K, opaque torrent and SFTP requests use exact whitelisted payloads', () => {
  assert.equal(request().source.url, magnet)
  const ed2k = `ed2k://|file|file.zip|100|${'b'.repeat(32)}|/`
  assert.deepEqual(request({ kind: 'ed2k', url: ed2k }).source, { kind: 'ed2k', url: ed2k })
  assert.deepEqual(request({ kind: 'torrent', token: 'opaque-torrent-token-1234' }).source, { kind: 'torrent', token: 'opaque-torrent-token-1234' })
  const sftp = request({ kind: 'sftp', url: 'sftp://server.test:2222/files/a.zip', hostKeySHA256: pin }, { credentials: { username: 'user', password: ' password with spaces ' }, folderPath: '/Downloads/SFTP' })
  assert.equal(sftp.credentials.password, ' password with spaces ')
  assert.equal(sftp.source.hostKeySHA256, pin)
  assert.equal(auxiliarySourceLabel(sftp.source), 'SFTP · server.test:2222')
  assert.equal(auxiliarySourceLabel(request().source), '磁力链接')
})

test('SFTP SHA256 pins require exactly 32 bytes and canonical Base64; no trust bypass can enter the request', () => {
  assert.equal(normalizeSFTPHostPin(pin), pin)
  assert.equal(normalizeSFTPHostPin(Buffer.alloc(32, 3).toString('base64')), pin)
  for (const bad of ['', 'SHA256:', Buffer.alloc(31).toString('base64'), 'MD5:00:00', pin + 'extra', pin.slice(0, -1) + '?', `SHA256:${'A'.repeat(42)}B`]) assert.equal(normalizeSFTPHostPin(bad), null)
  for (const source of [
    { kind: 'sftp', url: 'sftp://server.test/file', hostKeySHA256: '' },
    { kind: 'sftp', url: 'sftp://user:private-password@server.test/file', hostKeySHA256: pin },
    { kind: 'sftp', url: 'sftp://server.test/file?token=private-query', hostKeySHA256: pin },
    { kind: 'sftp', url: 'sftp://server.test/file', hostKeySHA256: pin, allowUnknownHost: true },
    { kind: 'sftp', url: 'https://server.test/file', hostKeySHA256: pin }
  ]) assert.throws(() => request(source, { credentials: { username: 'user', password: 'password' } }))
  assert.throws(() => request({ kind: 'sftp', url: 'sftp://server.test/file', hostKeySHA256: pin }))
})

test('sources reject HTTP, arbitrary paths, encoded traversal, unsupported parameters and auto-starting BT payloads', () => {
  for (const source of [
    { kind: 'http', url: 'https://example.test/file' },
    { kind: 'torrent', path: '/private/arbitrary.torrent' },
    { kind: 'torrent', token: '/private/arbitrary.torrent' },
    { kind: 'magnet', url: 'magnet:?dn=missing-hash' },
    { kind: 'magnet', url: 'javascript:alert(1)' },
    { kind: 'ed2k', url: `ed2k://|file|..%2Fescape|100|${'a'.repeat(32)}|/` },
    { kind: 'ed2k', url: `ed2k://|file|name|99999999999999999999|${'a'.repeat(32)}|/` },
    { kind: 'ed2k', url: `ed2k://|file|name|100|${'a'.repeat(32)}|/`, serverList: '/private/list' }
  ]) assert.throws(() => request(source))
  assert.throws(() => request(undefined, { autoStart: true }))
  assert.throws(() => request(undefined, { folderPath: 'relative/path' }))
  assert.throws(() => request(undefined, { credentials: { username: 'unexpected', password: 'private' } }))
  assert.throws(() => request(undefined, { creationKey: 'new-key-every-time', arbitrary: true }))
})

test('capabilities must be explicit and BitTorrent requires the file-selection gate', () => {
  assert.equal(readAuxiliaryCapabilities({ ok: true, capabilities: { bittorrent: true } }), null)
  assert.equal(readAuxiliaryCapabilities({ ok: false, error: 'secret' }), null)
  const flags = readAuxiliaryCapabilities({ ok: true, capabilities: { bittorrent: true, ed2k: false, sftp: true, fileSelection: false, stopSeeding: false } })
  assert.equal(supportsAuxiliaryProtocol(flags, 'magnet'), false)
  assert.equal(supportsAuxiliaryProtocol(flags, 'torrent'), false)
  assert.equal(supportsAuxiliaryProtocol(flags, 'ed2k'), false)
  assert.equal(supportsAuxiliaryProtocol(flags, 'sftp'), true)
})

test('unknown errors and source summaries never echo passwords, auth headers, URL parameters or raw messages', () => {
  for (const code of ['unknown', '__proto__', 'constructor', undefined]) {
    const message = auxiliaryErrorMessage({ code, error: 'sftp://private-user:private-password@host/file?secret=private-query Cookie: private-cookie Authorization: private-auth' })
    assert.ok(!message.includes('private-'))
  }
  assert.match(auxiliaryErrorMessage({ code: 'hostKeyMismatch', error: 'private-password' }), /公钥/)
  assert.equal(auxiliarySourceLabel({ kind: 'sftp', url: 'sftp://private-user:private-password@host/file?private-query', hostKeySHA256: pin }), 'SFTP · host')
  assert.equal(auxiliarySourceLabel(request().source), '磁力链接')
})

test('manifest decoder preserves seeding versus completion, rejects mismatched IDs and unsafe or duplicate paths', () => {
  const seeding = readAuxiliarySnapshot({ ok: true, snapshot: snapshot({ phase: 'seeding', completedBytes: 300, payloadCompleted: true, uploadSpeed: 4096 }) }, 7)
  assert.equal(seeding.phase, 'seeding')
  assert.equal(seeding.payloadCompleted, true)
  assert.equal(seeding.ratio, undefined)
  assert.equal(seeding.uploadedBytes, undefined)
  for (const invalid of [
    snapshot({ taskID: 8 }), snapshot({ generation: -1 }), snapshot({ phase: 'unknown' }), snapshot({ phase: 'complete', payloadCompleted: false }),
    snapshot({ totalBytes: NaN }), snapshot({ completedBytes: 301 }), snapshot({ phase: '__proto__' }),
    ...['../escape', '/absolute', 'C:\\escape', 'a/../escape', 'a//b', 'a\u0000b'].map(relativePath => snapshot({ files: [{ ...snapshot().files[0], relativePath }] })),
    snapshot({ files: [snapshot().files[0], snapshot().files[0]] }),
    snapshot({ files: [{ ...snapshot().files[0], completedLength: 101 }] })
  ]) assert.equal(readAuxiliarySnapshot({ ok: true, snapshot: invalid }, 7), null)
})

test('file selection requires confirmed pause, nonempty unique manifest indices and sends no paths', () => {
  for (const phase of ['metadata', 'downloading', 'checking', 'seeding', 'complete', 'error', 'removed']) assert.throws(() => auxiliarySelectionRequest(snapshot({ phase }), [1], true), /暂停/)
  for (const indices of [[], [1, 1], [3], [-1], [1.5], ['1']]) assert.throws(() => auxiliarySelectionRequest(snapshot(), indices, true))
  const payload = auxiliarySelectionRequest(snapshot(), [2, 1], true)
  assert.deepEqual(payload, { taskID: 7, generation: 3, indices: [1, 2], autoStart: true })
  assert.ok(!JSON.stringify(payload).includes('folder'))
})

test('lost creation ACK reconciles the same receipt without sending a second create', async () => {
  const calls = [], receipts = new Map(), intent = request()
  const controller = new AuxiliaryCreationController(intent, async (op, payload) => {
    calls.push({ op, payload })
    if (op === 'getCreationReceipt') return { ok: true, receipt: receipts.has(payload.creationKey) ? { taskID: receipts.get(payload.creationKey), taskExists: false } : null }
    receipts.set(payload.creationKey, 9)
    throw new Error('lost response Cookie: private-cookie')
  })
  assert.equal((await controller.reconcile(true)).phase, 'unconfirmed')
  const resumed = await controller.reconcile(false)
  assert.deepEqual(resumed, { phase: 'accepted', taskID: 9, creationKey: intent.creationKey, label: '磁力链接' })
  await controller.reconcile(true)
  assert.equal(calls.filter(call => call.op === 'auxiliaryCreate').length, 1)
})

test('all retries use a captured immutable request and key, and snapshots never contain credentials', async () => {
  const intent = request({ kind: 'sftp', url: 'sftp://server.test/file', hostKeySHA256: pin }, { credentials: { username: 'private-user', password: 'private-password' } })
  const original = structuredClone(intent), creates = []
  const controller = new AuxiliaryCreationController(intent, async (op, payload) => {
    if (op === 'getCreationReceipt') return { ok: true, receipt: null }
    creates.push(payload)
    if (creates.length === 1) throw new Error('Authorization: private-auth')
    return { ok: true, taskID: 12 }
  })
  intent.credentials.password = 'modified'
  intent.source.url = 'sftp://attacker.test/file'
  const unconfirmed = await controller.reconcile(true)
  assert.ok(!JSON.stringify(unconfirmed).includes('private-'))
  const accepted = await controller.reconcile(true)
  assert.equal(accepted.taskID, 12)
  assert.deepEqual(creates, [original, original])
  assert.equal(controller.intent, null, 'the request containing the password is released after ACK')
})

test('receipt pending or lookup failure prevents create and cannot unlock a fresh intent', async () => {
  for (const lookup of [async () => ({ ok: true, receipt: null, pending: true }), async () => ({ ok: false, code: 'unavailable', error: 'private-secret' }), async () => { throw new Error('private-secret') }]) {
    let creates = 0
    const controller = new AuxiliaryCreationController(request(), async op => { if (op === 'getCreationReceipt') return lookup(); creates++; return { ok: true, taskID: 1 } })
    const state = await controller.reconcile(true)
    assert.equal(state.phase, 'unconfirmed')
    assert.ok(!JSON.stringify(state).includes('private-secret'))
    assert.equal(creates, 0)
  }
})

test('only explicit pre-dispatch invalidRequest rejection allows editing; generic rejection stays unconfirmed', async () => {
  for (const code of ['invalidRequest', 'unavailable', 'hostKeyMismatch', undefined]) {
    const controller = new AuxiliaryCreationController(request(), async op => op === 'getCreationReceipt' ? { ok: true, receipt: null } : { ok: false, code, error: 'private-password' })
    const state = await controller.reconcile(true)
    assert.equal(state.phase, code === 'invalidRequest' ? 'rejected' : 'unconfirmed')
    assert.ok(!JSON.stringify(state).includes('private-password'))
    if (code === 'invalidRequest') assert.equal(controller.intent, null)
  }
})

test('concurrent create clicks serialize and acknowledge one task only', async () => {
  let creates = 0
  const controller = new AuxiliaryCreationController(request(), async op => {
    if (op === 'getCreationReceipt') return { ok: true, receipt: null }
    creates++
    await new Promise(resolve => setImmediate(resolve))
    return { ok: true, task: { id: 8 } }
  })
  const results = await Promise.all([controller.reconcile(true), controller.reconcile(true)])
  assert.deepEqual(results[0], results[1])
  assert.equal(creates, 1)
})
