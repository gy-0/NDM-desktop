import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
import { writeAtomicWindowsState } from '../src/main/windows/creationReceipts.ts'

function gate() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-creation-'))
  const downloads = join(root, 'downloads')
  await mkdir(downloads)
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { stateDirectory: root, defaultDownloadDirectory: downloads, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  const launches = []
  const engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} })
  engine.rpc.call = async (method, args) => {
    if (method === 'addUri') { launches.push(args); return `gid-${launches.length}` }
    return 'OK'
  }
  return { root, downloads, options, engine, launches, state: () => readFile(join(root, 'state.json'), 'utf8') }
}

test('Windows creation commits before starting and replays once across a lost reply and restart', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID()
  const input = { creationKey, url: 'https://example.test/guide.pdf', filename: 'Guide.pdf', connections: 4 }
  const started = gate(), release = gate()
  f.engine.rpc.call = async (method) => {
    assert.equal(method, 'addUri')
    const disk = JSON.parse(await f.state())
    assert.equal(disk.tasks.length, 1)
    assert.equal(disk.creationReceipts.entries[0].taskID, disk.tasks[0].id)
    started.resolve()
    await release.promise
    return 'original-gid'
  }
  const discardedReply = f.engine.request('add', input)
  await started.promise
  const acknowledged = await f.engine.request('getCreationReceipt', { creationKey })
  assert.equal(acknowledged.receipt.taskExists, true)
  // The engine has committed but the simulated original caller has no reply.
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  restarted.rpc.call = async () => assert.fail('receipt replay must not start another transfer')
  const replay = await restarted.request('add', input)
  assert.equal(replay.task.id, acknowledged.task.id)
  assert.equal(replay.task.status, 'paused')
  assert.equal((await restarted.request('list')).tasks.length, 1)
  release.resolve()
  await discardedReply
})

test('Windows receipt lookup remains pending during atomic persistence and concurrent same-key adds share the result', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID()
  const input = { creationKey, url: 'https://example.test/one.zip', autoStart: false }
  const writing = gate(), release = gate()
  const write = f.engine.writeState.bind(f.engine)
  f.engine.writeState = async (payload) => { writing.resolve(); await release.promise; await write(payload) }
  const first = f.engine.request('add', input)
  await writing.promise
  const second = f.engine.request('add', input)
  const lookup = await f.engine.request('getCreationReceipt', { creationKey })
  assert.deepEqual(lookup, { ok: true, receipt: null, pending: true })
  assert.deepEqual((await f.engine.request('list')).tasks, [])
  await assert.rejects(f.engine.request('add', { ...input, filename: 'different.zip' }), /请求已更改/)
  release.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.task.id, b.task.id)
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  assert.equal(JSON.parse(await f.state()).creationReceipts.entries.length, 1)
})

test('Windows concurrent distinct creations and an older queued save retain every task and receipt', async (t) => {
  const f = await fixture(t)
  const writing = gate(), release = gate()
  const write = f.engine.writeState.bind(f.engine)
  let writes = 0
  f.engine.writeState = async (payload) => {
    if (++writes === 1) { writing.resolve(); await release.promise }
    await write(payload)
  }
  const inputs = Array.from({ length: 12 }, (_, i) => ({
    creationKey: randomUUID(), url: `https://example.test/file-${i}.zip`, autoStart: false
  }))
  const first = f.engine.request('add', inputs[0])
  await writing.promise
  const oldSave = f.engine.persist()
  const more = inputs.slice(1).map((input) => f.engine.request('add', input))
  const settings = f.engine.request('updateSettings', { maxConnections: 6 })
  release.resolve()
  const replies = await Promise.all([first, ...more])
  await Promise.all([oldSave, settings])
  const disk = JSON.parse(await f.state())
  assert.equal(new Set(replies.map((reply) => reply.task.id)).size, 12)
  assert.equal(disk.tasks.length, 12)
  assert.equal(disk.creationReceipts.entries.length, 12)
  assert.equal(disk.settings.maxConnections, 6)
  for (const receipt of disk.creationReceipts.entries) assert.ok(disk.tasks.some((task) => task.id === receipt.taskID))
})

test('Windows atomic write failure preserves the prior state and leaves no phantom task or receipt', async (t) => {
  const f = await fixture(t)
  await f.engine.request('add', { url: 'https://example.test/old.zip', autoStart: false })
  const previous = await f.state()
  const creationKey = randomUUID()
  const input = { creationKey, url: 'https://example.test/new.zip' }
  const blockingDirectory = join(f.root, 'cannot-replace-a-directory')
  await mkdir(blockingDirectory)
  const write = f.engine.writeState.bind(f.engine)
  f.engine.writeState = (payload) => writeAtomicWindowsState(blockingDirectory, payload)
  await assert.rejects(f.engine.request('add', input), /EISDIR|EPERM|EEXIST/)
  assert.equal(await f.state(), previous)
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  assert.deepEqual(await f.engine.request('getCreationReceipt', { creationKey }), { ok: true, receipt: null })
  assert.equal(f.launches.length, 0)
  assert.equal((await readdir(f.root)).some((name) => name.endsWith('.tmp')), false)
  // Queued persistence after a failed create must not resurrect its candidate.
  f.engine.writeState = write
  await f.engine.request('updateSettings', { maxConnections: 5 })
  assert.equal(JSON.parse(await f.state()).tasks.length, 1)
  const reply = await f.engine.request('add', input)
  assert.equal(reply.task.id, 2)
  assert.equal(f.launches.length, 1)
})

test('Windows removal preserves a durable tombstone; replay after restart never recreates a deleted task', async (t) => {
  const f = await fixture(t)
  const input = { creationKey: randomUUID(), url: 'https://example.test/deleted.zip', autoStart: false }
  const added = await f.engine.request('add', input)
  await f.engine.request('remove', { taskID: added.task.id })
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  const replay = await restarted.request('add', input)
  assert.deepEqual(replay, { ok: true, receipt: { taskID: added.task.id, taskExists: false } })
  const next = await restarted.request('add', { ...input, creationKey: randomUUID() })
  assert.ok(next.task.id > added.task.id)
  assert.equal((await restarted.request('list')).tasks.length, 1)
})

test('Windows failed removal commit keeps the receipt taskExists truthful', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID()
  const added = await f.engine.request('add', { creationKey, url: 'https://example.test/keep.zip', autoStart: false })
  const previous = await f.state()
  f.engine.writeState = async () => { throw new Error('ENOSPC test disk full') }
  await assert.rejects(f.engine.request('remove', { taskID: added.task.id }), /ENOSPC/)
  assert.equal((await f.engine.request('getCreationReceipt', { creationKey })).receipt.taskExists, true)
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  assert.equal(await f.state(), previous)
})

test('Windows start failures return the committed error task, not a rejected creation that duplicates on retry', async (t) => {
  const f = await fixture(t)
  let attempts = 0
  f.engine.rpc.call = async () => { attempts++; throw new Error('aria2 unavailable') }
  const input = { creationKey: randomUUID(), url: 'https://example.test/unavailable.zip' }
  const reply = await f.engine.request('add', input)
  assert.equal(reply.ok, true)
  assert.equal(reply.task.status, 'error')
  assert.match(reply.task.errorText, /aria2 unavailable/)
  const replay = await f.engine.request('add', input)
  assert.equal(replay.task.id, reply.task.id)
  assert.equal(attempts, 1)
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  assert.equal((await restarted.request('getCreationReceipt', { creationKey: input.creationKey })).task.status, 'error')
})

test('Windows failure saving a post-create status still returns the already durable creation receipt', async (t) => {
  const f = await fixture(t)
  const write = f.engine.writeState.bind(f.engine)
  let writes = 0
  f.engine.writeState = async (payload) => {
    if (++writes > 1) throw new Error('ENOSPC after creation')
    await write(payload)
  }
  const input = { creationKey: randomUUID(), url: 'https://example.test/already-created.zip' }
  const created = await f.engine.request('add', input)
  assert.equal(created.ok, true)
  assert.equal(created.task.status, 'downloading')
  assert.equal(f.launches.length, 1)
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  const confirmed = await restarted.request('getCreationReceipt', { creationKey: input.creationKey })
  assert.equal(confirmed.receipt.taskID, created.task.id)
  assert.equal(confirmed.task.status, 'paused')
  assert.equal((await restarted.request('add', input)).task.id, created.task.id)
})

test('Windows shutdown flushes a pending creation without accepting a late start or hanging on RPC', async (t) => {
  const f = await fixture(t)
  const started = gate(), release = gate()
  const calls = []
  f.engine.rpc.call = async (method) => {
    calls.push(method)
    if (method === 'addUri') { started.resolve(); await release.promise; return 'late-gid' }
    return 'OK'
  }
  const input = { creationKey: randomUUID(), url: 'https://example.test/quitting.zip' }
  const creating = f.engine.request('add', input)
  await started.promise
  await f.engine.stop()
  assert.equal(JSON.parse(await f.state()).tasks[0].status, 'paused')
  release.resolve()
  const created = await creating
  assert.equal(created.task.status, 'paused')
  assert.ok(calls.includes('forceShutdown'))
  assert.ok(calls.includes('forceRemove'))
  assert.equal((await f.engine.request('getCreationReceipt', { creationKey: input.creationKey })).receipt.taskID, created.task.id)
})

test('Windows shutdown does not wait for media inspection or create its task after quitting', async (t) => {
  const f = await fixture(t)
  const probing = gate(), release = gate()
  const format = { format_id: '18', height: 360, ext: 'mp4', url: 'https://cdn.example.test/video.mp4', vcodec: 'avc1', acodec: 'mp4a' }
  f.engine.inspectMedia = async () => { probing.resolve(); await release.promise; return { title: 'A film', ...format, formats: [format] } }
  const creationKey = randomUUID()
  const creating = f.engine.request('addMedia', { creationKey, url: 'https://example.test/watch', formatID: '18' })
  const rejection = assert.rejects(creating, /正在退出/)
  await probing.promise
  await f.engine.stop()
  release.resolve()
  await rejection
  assert.deepEqual((await f.engine.request('list')).tasks, [])
  assert.deepEqual(await f.engine.request('getCreationReceipt', { creationKey }), { ok: true, receipt: null })
  assert.deepEqual(JSON.parse(await f.state()).tasks, [])
})

test('Windows same creation key rejects changed intent but tolerates refreshed cookies and later default changes', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID()
  const input = { creationKey, url: 'https://example.test/private.zip', autoStart: false, headers: ['Cookie: test-secret-one'] }
  const added = await f.engine.request('add', input)
  await f.engine.request('updateSettings', { maxConnections: 2, downloadDirectory: join(f.root, 'other') })
  const replay = await f.engine.request('add', { ...input, headers: ['Cookie: test-secret-two'] })
  assert.equal(replay.task.id, added.task.id)
  assert.equal(replay.task.folderPath, f.downloads)
  for (const changed of [
    { url: 'https://example.test/other.zip' }, { filename: 'renamed.zip' }, { autoStart: true },
    { folderPath: join(f.root, 'another') }, { connections: 8 }
  ]) await assert.rejects(f.engine.request('add', { ...input, ...changed }), /请求已更改/)
  const disk = await f.state()
  assert.equal(disk.includes('test-secret'), false)
  assert.equal(JSON.parse(disk).creationReceipts.entries[0].intentDigest.length, 64)
})

test('Windows unkeyed adds remain independent and legacy state migrates without losing history', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'state.json'), JSON.stringify({
    nextId: 8, tasks: [{ id: 7, url: 'https://example.test/old.zip', filename: 'old.zip', status: 'paused', folderPath: f.downloads }]
  }))
  const input = { url: 'https://example.test/repeated.zip', autoStart: false }
  const [a, b] = await Promise.all([f.engine.request('add', input), f.engine.request('add', input)])
  assert.notEqual(a.task.id, b.task.id)
  assert.equal((await f.engine.request('list')).tasks.length, 3)
  assert.equal(JSON.parse(await f.state()).creationReceipts.entries.length, 0)
})

test('Windows unkeyed start failures preserve the legacy caller rejection contract', async (t) => {
  const f = await fixture(t)
  f.engine.rpc.call = async () => { throw new Error('legacy start failure') }
  await assert.rejects(f.engine.request('add', { url: 'https://example.test/legacy.zip' }), /legacy start failure/)
  assert.equal((await f.engine.request('list')).tasks[0].status, 'error')
  assert.deepEqual(JSON.parse(await f.state()).creationReceipts.entries, [])
})

test('Windows media lookup is pending while probing; duplicate media requests do not re-probe or start twice', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID(), probing = gate(), release = gate()
  const format = { format_id: '18', height: 360, ext: 'mp4', url: 'https://cdn.example.test/video.mp4', vcodec: 'avc1', acodec: 'mp4a', filesize: 1024 }
  let probes = 0
  f.engine.inspectMedia = async () => {
    probes++
    probing.resolve()
    await release.promise
    return { title: 'A film', ...format, formats: [format] }
  }
  const input = { creationKey, url: 'https://example.test/watch', formatID: '18' }
  const first = f.engine.request('addMedia', input)
  await probing.promise
  const second = f.engine.request('addMedia', input)
  assert.deepEqual(await f.engine.request('getCreationReceipt', { creationKey }), { ok: true, receipt: null, pending: true })
  await assert.rejects(f.engine.request('add', { ...input, autoStart: false }), /请求已更改/)
  release.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.task.id, b.task.id)
  assert.equal(probes, 2)
  assert.equal(f.launches.length, 1)
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  restarted.inspectMedia = async () => assert.fail('replay must not need the expired media URL')
  assert.equal((await restarted.request('addMedia', input)).task.id, a.task.id)
  await assert.rejects(restarted.request('addMedia', { ...input, container: 'compactMKV' }), /请求已更改/)
})

test('Windows media probe rejection has no receipt and may safely retry the same operation', async (t) => {
  const f = await fixture(t)
  const creationKey = randomUUID()
  f.engine.inspectMedia = async () => { throw new Error('probe unavailable') }
  await assert.rejects(f.engine.request('addMedia', { creationKey, url: 'https://example.test/watch', formatID: '18' }), /probe unavailable/)
  assert.deepEqual(await f.engine.request('getCreationReceipt', { creationKey }), { ok: true, receipt: null })
  assert.equal((await f.engine.request('list')).tasks.length, 0)
})

for (const invalid of ['{bad-json', JSON.stringify({ tasks: [], creationReceipts: { version: 2, entries: [] } }),
  JSON.stringify({ tasks: [], creationReceipts: { version: 1, entries: [{ creationKey: randomUUID(), taskID: 1 }] } })]) {
  test('Windows unreadable durable history cannot masquerade as an absent creation receipt', async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, 'state.json'), invalid)
    const creationKey = randomUUID()
    await assert.rejects(f.engine.request('getCreationReceipt', { creationKey }))
    await assert.rejects(f.engine.request('add', { creationKey, url: 'https://example.test/file.zip', autoStart: false }))
    await assert.rejects(f.engine.request('updateSettings', { maxConnections: 4 }))
    assert.equal(await f.state(), invalid)
  })
}

test('Windows rejects malformed creation keys without creating tasks', async (t) => {
  const f = await fixture(t)
  for (const creationKey of ['', 1, null, 'not-a-key']) {
    await assert.rejects(f.engine.request('add', { creationKey, url: 'https://example.test/file.zip' }), /标识无效/)
    await assert.rejects(f.engine.request('getCreationReceipt', { creationKey }), /标识无效/)
  }
  assert.equal((await f.engine.request('list')).tasks.length, 0)
})
