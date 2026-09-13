import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return encode(Buffer.from(value))
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')])
}
const binary = join(process.cwd(), 'native/Vendor/Tools/aria2-next')
const skip = process.env.NDM_RUN_AUXILIARY_REAL !== '1' || process.platform !== 'darwin' || !existsSync(binary)
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-win-bt-controls-real-'))
  const options = { stateDirectory: join(root, 'state'), defaultDownloadDirectory: join(root, 'downloads'), aria2Path: '', ytDlpPath: '', ffmpegPath: '', auxiliaryPath: binary,
    auxiliaryManifestPath: join(process.cwd(), 'native/Vendor/Tools/aria2-next-manifest.json'), auxiliaryLoopbackOnly: true, auxiliaryPeerDiscovery: false }
  await mkdir(options.stateDirectory); await mkdir(options.defaultDownloadDirectory)
  const engines = []
  const engine = () => { const value = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); engines.push(value); return value }
  t.after(async () => { for (const item of engines) await item.auxiliaryDaemon.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, engine }
}
function torrent(payload, url) {
  const pieces = []
  for (let offset = 0; offset < payload.length; offset += 16384) pieces.push(createHash('sha1').update(payload.subarray(offset, offset + 16384)).digest())
  return encode({ ...(url ? { 'url-list': url } : {}), info: { name: 'fixture.bin', length: payload.length, 'piece length': 16384, pieces: Buffer.concat(pieces) } }).toString('base64')
}
test('real Windows BT controls change trackers/webseeds while never unpaused, clear seed-time with same GID, and replay global encryption after restart', { skip, timeout: 30000 }, async t => {
  const f = await setup(t)
  let engine = f.engine()
  const added = await engine.request('auxiliaryCreate', { creationKey: randomUUID(), source: { kind: 'torrent', torrentData: torrent(Buffer.alloc(1024, 7)) }, autoStart: false })
  const binding = { taskID: added.taskID, generation: 1 }
  const path = join(f.root, 'state', 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  const gid = JSON.parse(await readFile(path, 'utf8')).gid
  const initial = await engine.request('auxiliaryBTStatus', binding)
  assert.equal(initial.ok, true); assert.equal(initial.state.config.seedMinutes, null)
  const config = { trackers: [{ url: 'http://127.0.0.1:9/announce', tier: 0 }], webSeeds: ['http://127.0.0.1:9/fixture.bin'], seedRatio: 2, seedMinutes: 12, uploadLimit: 65536, peerExchange: false }
  const changed = await engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 0, config })
  assert.equal(changed.ok, true, JSON.stringify(changed)); assert.deepEqual(changed.state.config, config)
  const marker = join(f.root, 'state', 'auxiliary-tasks', String(added.taskID), '1', 'files', 'owned-marker.txt')
  await writeFile(marker, 'preserve across admission release')
  const cleared = await engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 1, config: { ...config, seedMinutes: null } })
  assert.equal(cleared.ok, true, JSON.stringify(cleared)); assert.equal(cleared.state.revision, 2)
  const rpc = engine.auxiliaryDaemon.peekRPC()
  assert.equal((await rpc.call('aria2.getOption', [gid]))['seed-time'], undefined)
  assert.equal((await rpc.call('aria2.tellStatus', [gid])).status, 'paused')
  assert.equal((await rpc.call('aria2.tellStatus', [gid])).completedLength, '0')
  assert.equal(await readFile(marker, 'utf8'), 'preserve across admission release')
  assert.deepEqual(await engine.request('auxiliaryBTAddPeers', { ...binding, peers: ['127.0.0.1:9'] }), { ok: true, added: 1, failed: 0 })
  const encryption = await engine.request('auxiliaryBTGlobalConfigure', { expectedRevision: 0, encryption: 'required' })
  assert.equal(encryption.ok, true, JSON.stringify(encryption)); assert.equal((await rpc.call('aria2.getGlobalOption'))['bt-encryption'], 'required')
  await engine.auxiliaryDaemon.stop()
  engine = f.engine()
  const recovered = await engine.request('auxiliaryBTStatus', binding)
  assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.state.revision, 2); assert.equal(recovered.state.config.seedMinutes, null)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).gid, gid)
  assert.equal((await engine.request('auxiliaryBTGlobalStatus')).state.encryption, 'required')
  assert.equal((await engine.auxiliaryDaemon.peekRPC().call('aria2.getGlobalOption'))['bt-encryption'], 'required')
  assert.equal((await engine.auxiliaryDaemon.peekRPC().call('aria2.tellStatus', [gid])).completedLength, '0')
})

test('per-task budget overlay bounds the pinned libtorrent localhost exemption without changing the user task limit', { skip, timeout: 30000 }, async t => {
  const f = await setup(t), engine = f.engine(), payload = Buffer.alloc(1024 * 1024, 13)
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1
    res.writeHead(match ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {}) }); res.end(payload.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 131072 })
  const added = await engine.request('auxiliaryCreate', { creationKey: randomUUID(), source: { kind: 'torrent', torrentData: torrent(payload, `http://127.0.0.1:${server.address().port}/fixture.bin`) }, autoStart: false })
  const started = Date.now()
  await engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [1], autoStart: true })
  let snapshot
  do { await delay(100); snapshot = (await engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot } while (!snapshot.payloadCompleted && Date.now() - started < 18000)
  const seconds = (Date.now() - started) / 1000
  assert.equal(snapshot.payloadCompleted, true); assert.ok(seconds >= 4, `Local payload ignored per-task overlay: ${seconds}s`)
  const task = (await engine.request('list')).tasks[0]
  assert.equal(task.bandwidthLimit, 0, 'Budget allocation must not replace the user preference')
  const journal = JSON.parse(await readFile(join(f.root, 'state', 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json'), 'utf8'))
  assert.equal(journal.bandwidthLimit, 0)
  assert.equal((await engine.auxiliaryDaemon.peekRPC().call('aria2.getOption', [journal.gid]))['max-download-limit'], '131072')
  if (snapshot.phase === 'seeding') await engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  const final = (await engine.request('list')).tasks[0]
  assert.deepEqual(await readFile(join(final.folderPath, final.filename)), payload)
  t.diagnostic(JSON.stringify({ localBTOverlay: true, bytes: payload.length, seconds, limit: 131072 }))
})
