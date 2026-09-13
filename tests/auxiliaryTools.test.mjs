import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuxiliaryToolsService } from '../src/main/auxiliaryTools.ts'

const magnet = () => ({ creationKey: randomUUID(), source: { kind: 'magnet', url: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }, autoStart: false })
async function fixture(t, handler = async () => ({ ok: true, taskID: 7 })) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-auxiliary-tools-'))
  const path = join(root, 'fixture.torrent'), bytes = Buffer.from('d4:infod4:name7:fixtureee')
  await writeFile(path, bytes)
  let chosen = path
  const calls = []
  const service = new AuxiliaryToolsService({ platform: 'posix', chooseTorrent: async () => chosen,
    request: async (op, payload) => { calls.push({ op, payload }); return handler(op, payload) } })
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }) })
  return { service, calls, path, root, bytes, choose: path => { chosen = path } }
}

test('main captures selected torrent bytes behind an opaque token and strips paths from renderer replies', async t => {
  const { service, calls, path, bytes } = await fixture(t, async op => op === 'getCreationReceipt' ? { ok: true, receipt: null } : { ok: true, taskID: 42 })
  const selected = await service.request('auxiliaryChooseTorrent')
  assert.deepEqual(Object.keys(selected.torrent).sort(), ['filename', 'token'])
  assert.ok(!JSON.stringify(selected).includes(path))
  await writeFile(path, 'changed after selection')
  const request = { ...magnet(), source: { kind: 'torrent', token: selected.torrent.token } }
  assert.equal((await service.request('auxiliaryCreate', request)).taskID, 42)
  const created = calls.find(call => call.op === 'auxiliaryCreate').payload
  assert.equal(created.source.torrentData, bytes.toString('base64'))
  assert.deepEqual(Object.keys(created.source).sort(), ['kind', 'torrentData'])
  assert.equal((await service.request('auxiliaryCreate', request)).taskID, 42)
  assert.equal(calls.filter(call => call.op === 'auxiliaryCreate').length, 1)
})

test('main refuses non-regular and symlink torrent selections without exposing local filenames in errors', async t => {
  const { service, root, path, choose } = await fixture(t)
  const link = join(root, 'link.torrent')
  await symlink(path, link); choose(link)
  const result = await service.request('auxiliaryChooseTorrent')
  assert.equal(result.code, 'invalidSource'); assert.ok(!JSON.stringify(result).includes(root))
  choose(root + '.torrent')
  assert.equal((await service.request('auxiliaryChooseTorrent')).code, 'invalidSource')
  choose(null)
  assert.deepEqual(await service.request('auxiliaryChooseTorrent'), { ok: true, torrent: null })
})

test('invalid renderer source data never reaches the engine and is the only safely editable creation failure', async t => {
  const { service, calls } = await fixture(t)
  for (const source of [{ kind: 'torrent', path: '/private/file.torrent' }, { kind: 'torrent', torrentData: 'ZWU=' }, { kind: 'torrent', token: 'not-a-selected-token' }]) {
    assert.equal((await service.request('auxiliaryCreate', { ...magnet(), source })).code, 'invalidRequest')
  }
  assert.equal(calls.length, 0)
})

test('concurrent submissions share one immutable dispatch and unknown results retain the same intent', async t => {
  let release, attempts = 0
  const pending = new Promise(resolve => { release = resolve })
  const { service, calls } = await fixture(t, async op => {
    if (op === 'getCreationReceipt') return { ok: true, receipt: null }
    attempts++
    if (attempts === 1) { await pending; throw new Error('secret password') }
    return { ok: true, taskID: 9 }
  })
  const request = magnet()
  const first = service.request('auxiliaryCreate', request), second = service.request('auxiliaryCreate', request)
  await new Promise(resolve => setImmediate(resolve)); release()
  assert.equal((await first).code, 'receiptUnavailable'); assert.deepEqual(await second, await first)
  assert.equal(attempts, 1)
  assert.notEqual((await service.request('auxiliaryCreate', { ...request, source: { kind: 'torrent', token: 'missing-token-1234' } })).code, 'invalidRequest')
  assert.equal((await service.request('auxiliaryCreate', request)).taskID, 9)
  const creates = calls.filter(call => call.op === 'auxiliaryCreate')
  assert.deepEqual(creates[0].payload, creates[1].payload)
})

test('late creation receipt wins before a retry and engine errors never become pre-dispatch rejections', async t => {
  let receipt = null
  const { service, calls } = await fixture(t, async op => op === 'getCreationReceipt'
    ? { ok: true, receipt } : { ok: false, code: 'invalidRequest', error: 'private account' })
  const request = magnet()
  const unknown = await service.request('auxiliaryCreate', request)
  assert.notEqual(unknown.code, 'invalidRequest'); assert.ok(!JSON.stringify(unknown).includes('private'))
  receipt = { taskID: 13 }
  assert.equal((await service.request('auxiliaryCreate', request)).taskID, 13)
  assert.equal(calls.filter(call => call.op === 'auxiliaryCreate').length, 1)
})

test('status and authentication responses contain only the defined safe fields', async t => {
  const { service, calls } = await fixture(t, async op => op === 'auxiliaryStatus' ? { ok: true, snapshot: {
    taskID: 5, generation: 2, kind: 'sftp', phase: 'error', totalBytes: 0, completedBytes: 0, downloadSpeed: 0, uploadSpeed: 0,
    payloadCompleted: false, files: [], password: 'private secret', url: 'private URL'
  } } : { ok: true, password: 'private secret' })
  const status = await service.request('auxiliaryStatus', { taskID: 5, path: 'private path' })
  assert.equal(status.snapshot.kind, 'sftp'); assert.ok(!JSON.stringify(status).includes('private'))
  const reply = await service.request('auxiliaryAuthenticate', { taskID: 5, generation: 2, autoStart: true,
    credentials: { username: 'fixture', password: 'private secret', unexpected: 'drop' }, hostKeySHA256: 'changed pin' })
  assert.deepEqual(reply, { ok: true })
  assert.deepEqual(calls.at(-1).payload, { taskID: 5, generation: 2, autoStart: true, credentials: { username: 'fixture', password: 'private secret' } })
})

test('file selection validation rejects empty or duplicate IDs before any dispatch', async t => {
  const { service, calls } = await fixture(t)
  for (const indices of [[], [1, 1], [0], [1.2]]) {
    assert.equal((await service.request('auxiliarySelectFiles', { taskID: 5, generation: 2, autoStart: true, indices })).code, 'invalidSelection')
  }
  assert.equal(calls.length, 0)
})
