import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { BTTransferControlsService } from '../src/main/btTransferControls.ts'
import { BT_CONTROL_OPS, validateBTTaskConfig, validateBTPeers, parseBTTrackerLines, readBTControlsState, readBTGlobalState } from '../src/shared/btTransferControls.ts'

const config = () => ({ trackers: [{ url: 'https://tracker.invalid/a?passkey=secret', tier: 0 }], webSeeds: ['https://seed.invalid/payload?token=secret'], seedRatio: 1, seedMinutes: null, uploadLimit: 0, peerExchange: true })
const state = () => ({ taskID: 7, generation: 2, revision: 3, phase: 'paused', config: config(), trackers: [{ url: 'https://tracker.invalid/a?passkey=secret', tier: 0, status: 'idle', failures: 0, seeders: -1, leechers: -1 }], peers: [{ ip: '::1', port: 443, downloadSpeed: 50, uploadSpeed: 70, progress: 0.5, seeder: false, state: 'connected', encryption: 'rc4' }] })
const binding = { taskID: 7, generation: 2 }
function harness(overrides = {}) {
  const h = { task: state(), global: { revision: 8, encryption: 'preferred', canConfigure: true }, calls: [] }
  h.service = new BTTransferControlsService({ request: async (op, extra) => {
    h.calls.push({ op, extra: structuredClone(extra) })
    if (overrides[op]) return overrides[op](extra, h)
    if (op === 'auxiliaryBTGlobalStatus') return { ok: true, state: structuredClone(h.global) }
    if (op === 'auxiliaryBTGlobalConfigure') { h.global = { ...h.global, encryption: extra.encryption, revision: h.global.revision + 1 }; return { ok: true, state: structuredClone(h.global) } }
    if (op === 'auxiliaryBTStatus') return { ok: true, state: structuredClone(h.task) }
    if (op === 'auxiliaryBTConfigure') { h.task = { ...h.task, config: extra.config, revision: h.task.revision + 1 }; return { ok: true, state: structuredClone(h.task) } }
    if (op === 'auxiliaryBTAddPeers') return { ok: true, added: extra.peers.length, failed: 0 }
    throw new Error('unexpected')
  } })
  return h
}

test('BT config preserves signed URL bytes, tiers, sharing defaults and null versus zero', () => {
  const original = config(), normalized = validateBTTaskConfig(original)
  assert.deepEqual(normalized, original)
  assert.notEqual(normalized, original)
  assert.equal(validateBTTaskConfig({ ...original, seedMinutes: 0 }).seedMinutes, 0)
  assert.equal(validateBTTaskConfig({ ...original, seedRatio: 0 }).seedRatio, 0)
  assert.deepEqual(parseBTTrackerLines('2 https://tracker.invalid/announce\n udp://127.0.0.1:9000/a'), [{ tier: 2, url: 'https://tracker.invalid/announce' }, { tier: 0, url: 'udp://127.0.0.1:9000/a' }])
  assert.deepEqual(validateBTTaskConfig({ ...original, trackers: [], webSeeds: [] }).trackers, [])
  assert.equal(validateBTTaskConfig({ ...original, trackers: [...original.trackers, { ...original.trackers[0], tier: 4 }] }).trackers.length, 1)
  assert.deepEqual(validateBTTaskConfig({ ...original, trackers: [{ url: 'https://a.invalid/', tier: 9 }, { url: 'https://b.invalid/', tier: 2 }, { url: 'https://c.invalid/', tier: 9 }] }).trackers.map(tracker => tracker.tier), [1, 0, 1])
})

test('BT config rejects unsupported protocols, unsafe endpoints, accidental fields and invalid numeric settings', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http:tracker.invalid', 'http://host:0/a', 'https://host/a#fragment', 'https://host/\nsecret', 'ftp://host/a']) {
    assert.throws(() => validateBTTaskConfig({ ...config(), trackers: [{ url, tier: 0 }] }))
  }
  for (const patch of [{ gid: 'external' }, { seedRatio: NaN }, { seedRatio: -1 }, { seedMinutes: '' }, { seedMinutes: -1 }, { seedMinutes: 1.5 }, { seedMinutes: 35_791_395 }, { uploadLimit: 1.5 }, { uploadLimit: 2_147_483_648 }, { uploadLimit: Number.MAX_SAFE_INTEGER + 1 }, { peerExchange: 'true' }, { webSeeds: ['udp://host/a'] }, { trackers: [{ url: 'https://host/', tier: 256 }] }]) {
    assert.throws(() => validateBTTaskConfig({ ...config(), ...patch }))
  }
})

test('manual peers allow numeric IPv4 and bracketed IPv6 only and deduplicate canonical endpoints', () => {
  assert.deepEqual(validateBTPeers(['127.000.0.1:080', '127.0.0.1:80', '[0:0:0:0:0:0:0:1]:8080']), ['127.0.0.1:80', '[::1]:8080'])
  for (const peers of [[], ['host.invalid:80'], ['::1:80'], ['[::x]:80'], ['127.0.0.1:0'], ['300.1.2.3:80'], ['127.0.0.1:65536'], Array(129).fill('127.0.0.1:80')]) assert.throws(() => validateBTPeers(peers))
})

test('status sanitizes backend reply to known fields and rejects binding or malformed statistics', async () => {
  const h = harness()
  h.task.source = 'private magnet'
  h.task.peers[0].peerClientName = 'https://tracker.invalid/?token=secret'
  const reply = await h.service.request('auxiliaryBTStatus', binding)
  assert.equal(reply.ok, true)
  assert.equal(reply.state.source, undefined)
  assert.equal(reply.state.peers[0].peerClientName, undefined)
  for (const patch of [{ taskID: 8 }, { generation: 3 }, { revision: -1 }, { peers: [{ ...state().peers[0], progress: 2 }] }, { config: { ...config(), seedRatio: '1' } }]) {
    assert.equal(readBTControlsState({ ok: true, state: { ...state(), ...patch } }, 7, 2), null)
  }
  assert.equal(readBTGlobalState({ ok: true, state: { revision: 0, encryption: 'required', canConfigure: true, secret: 'hidden' } }).secret, undefined)
})

test('the service exposes exactly five BT operations and rejects gid/path/raw RPC injection before dispatch', async () => {
  const h = harness()
  for (const op of BT_CONTROL_OPS) assert.equal(h.service.supports(op), true)
  for (const [op, extra] of [['aria2.changeOption', {}], ['auxiliaryBTStatus', { ...binding, gid: '1234' }], ['auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: { ...config(), dir: '/tmp' } }], ['auxiliaryBTGlobalStatus', { taskID: 7 }], ['auxiliaryBTStatus', { ...binding, generation: -1 }]]) {
    assert.equal((await h.service.request(op, extra)).ok, false)
  }
  assert.equal(h.calls.length, 0)
})

test('all running or terminal phases reject configuration and peer mutations before dispatch', async () => {
  for (const phase of ['metadata', 'checking', 'downloading', 'seeding', 'complete', 'removed', 'error']) {
    const h = harness(); h.task.phase = phase
    assert.equal((await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: config() })).code, 'notPaused')
    assert.equal((await h.service.request('auxiliaryBTAddPeers', { ...binding, peers: ['127.0.0.1:9000'] })).code, 'notPaused')
    assert.ok(h.calls.every(call => call.op === 'auxiliaryBTStatus'))
  }
})

test('paused and selection-waiting configurations round-trip full settings and monotonic revision', async () => {
  for (const phase of ['paused', 'awaitingSelection']) {
    const h = harness(); h.task.phase = phase
    const requested = { ...config(), trackers: [], webSeeds: [], seedRatio: 2, seedMinutes: 0, uploadLimit: 4096, peerExchange: false }
    const reply = await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: requested })
    assert.equal(reply.ok, true)
    assert.equal(reply.state.revision, 4)
    assert.deepEqual(reply.state.config, requested)
    assert.deepEqual((await h.service.request('auxiliaryBTStatus', binding)).state.config, requested)
  }
})

test('stale task generation and revision cannot change new state', async () => {
  const h = harness()
  assert.equal((await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 2, config: config() })).code, 'conflict')
  h.task.generation = 3
  assert.equal((await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: config() })).ok, false)
  assert.ok(h.calls.every(call => call.op === 'auxiliaryBTStatus'))
})

test('lost or incomplete configuration ACK is unconfirmed, never fabricated success or rollback', async () => {
  for (const result of [{ ok: true }, { ok: true, state: state() }, { ok: true, state: { ...state(), config: { ...config(), seedRatio: 2 } } }]) {
    const h = harness({ auxiliaryBTConfigure: () => result })
    const reply = await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: { ...config(), seedRatio: 2 } })
    assert.equal(reply.code, 'unconfirmed')
    assert.equal(h.calls.filter(call => call.op === 'auxiliaryBTConfigure').length, 1)
  }
})

test('manual peers report partial acceptance distinctly and require all results accounted for', async () => {
  const h = harness({ auxiliaryBTAddPeers: () => ({ ok: true, added: 1, failed: 1, error: 'secret' }) })
  assert.deepEqual(await h.service.request('auxiliaryBTAddPeers', { ...binding, peers: ['127.0.0.1:9001', '[::1]:9001'] }), { ok: true, added: 1, failed: 1 })
  const bad = harness({ auxiliaryBTAddPeers: () => ({ ok: true, added: 20, failed: 0 }) })
  assert.equal((await bad.service.request('auxiliaryBTAddPeers', { ...binding, peers: ['127.0.0.1:9001'] })).code, 'unconfirmed')
})

test('global encryption requires all tasks paused, a matching revision and real readback', async () => {
  const h = harness(); h.global.canConfigure = false
  assert.equal((await h.service.request('auxiliaryBTGlobalConfigure', { expectedRevision: 8, encryption: 'required' })).code, 'allTasksMustPause')
  h.global.canConfigure = true
  assert.equal((await h.service.request('auxiliaryBTGlobalConfigure', { expectedRevision: 7, encryption: 'required' })).code, 'conflict')
  assert.equal(h.calls.some(call => call.op === 'auxiliaryBTGlobalConfigure'), false)
  const reply = await h.service.request('auxiliaryBTGlobalConfigure', { expectedRevision: 8, encryption: 'required' })
  assert.deepEqual(reply.state, { revision: 9, encryption: 'required', canConfigure: true })
  const fake = harness({ auxiliaryBTGlobalConfigure: () => ({ ok: true }) })
  assert.equal((await fake.service.request('auxiliaryBTGlobalConfigure', { expectedRevision: 8, encryption: 'disabled' })).code, 'unconfirmed')
})

test('raw source URL tokens in exceptions or errors never escape the service', async () => {
  const secret = 'https://tracker.invalid/path?passkey=VERY_SECRET'
  for (const rejected of [() => { throw new Error(secret) }, () => ({ ok: false, code: secret, error: secret }), () => ({ ok: false, code: 'storage', error: secret })]) {
    const h = harness({ auxiliaryBTConfigure: rejected })
    const reply = await h.service.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 3, config: config() })
    assert.equal(reply.ok, false)
    assert.equal(JSON.stringify(reply).includes('VERY_SECRET'), false)
  }
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
function bencode(value) {
  if (Buffer.isBuffer(value) || typeof value === 'string') { const data = Buffer.from(value); return Buffer.concat([Buffer.from(`${data.length}:`), data]) }
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}

test('pinned Aria2 Next RPC accepts and reads back paused BT tracker/webseed/peer/sharing and global encryption controls', { skip: !process.env.NDM_BT_RPC_ENGINE, timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-bt-controls-rpc-'))
  const port = await freePort(), listen = await freePort(), ed2k = await freePort(), udp = await freePort()
  const secret = randomBytes(24).toString('hex')
  await mkdir(join(root, 'files'))
  const child = spawn(process.env.NDM_BT_RPC_ENGINE, ['--no-conf=true', '--enable-rpc=true', '--rpc-listen-all=false', `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`,
    `--state-dir=${join(root, 'state')}`, `--dir=${join(root, 'files')}`, `--listen-port=${listen}`, `--ed2k-listen-port=${ed2k}`, `--ed2k-udp-listen-port=${udp}`,
    '--bt-interface=127.0.0.1', '--disable-ipv6=true', '--bt-port-mapping=false', '--enable-dht=false', '--enable-peer-exchange=false', '--bt-enable-lpd=false', '--console-log-level=error', '--summary-interval=0', '--show-console-readout=false'], { stdio: 'ignore' })
  let spawnError
  child.on('error', error => { spawnError = error })
  const rpc = async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [`token:${secret}`, ...params] }), signal: AbortSignal.timeout(3000) })
    const reply = await response.json()
    if (reply.error) throw Object.assign(new Error(`RPC ${method} failed (code ${reply.error.code})`), {
      taskNotFound: /(?:GID [a-f\d]+ is not found|No such download for GID#[a-f\d]+)/i.test(reply.error.message ?? '')
    })
    return reply.result
  }
  t.after(async () => {
    if (child.exitCode === null && !spawnError) {
      await rpc('aria2.forceShutdown').catch(() => undefined)
      await Promise.race([once(child, 'exit'), sleep(5000)])
      if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
    }
    await rm(root, { recursive: true, force: true })
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) { if (spawnError) throw new Error('Fixture engine could not start'); try { await rpc('aria2.getVersion'); ready = true; break } catch { await sleep(50) } }
  assert.equal(ready, true)
  const methods = await rpc('system.listMethods')
  for (const method of ['aria2.getBtTrackers', 'aria2.replaceBtTrackers', 'aria2.replaceBtWebSeeds', 'aria2.addBtPeers', 'aria2.getPeers', 'aria2.getOption', 'aria2.changeGlobalOption']) assert.ok(methods.includes(method), method)
  const payload = Buffer.alloc(256 * 1024, 0x5a)
  const torrent = bencode({ info: { name: 'bt-control-fixture.bin', length: payload.length, 'piece length': payload.length, pieces: createHash('sha1').update(payload).digest() } })
  const gid = await rpc('aria2.addTorrent', [torrent.toString('base64'), [], { pause: 'true', 'pause-metadata': 'true', 'allow-overwrite': 'false', 'auto-file-renaming': 'false' }])
  let before = await rpc('aria2.getOption', [gid])
  assert.equal(Number(before['seed-ratio']), 1)
  assert.equal(before['seed-time'], undefined)
  const initialSeeds = ['http://127.0.0.1:9/initial-files/']
  assert.equal(await rpc('aria2.replaceBtWebSeeds', [gid, initialSeeds]), gid)
  assert.deepEqual((await rpc('aria2.tellStatus', [gid])).bittorrent.webSeeds, initialSeeds)
  t.diagnostic('neverStartedPausedNonemptyWebSeedReplaceAndReadback=true; unpauseCalls=0')
  assert.equal((await rpc('aria2.tellStatus', [gid])).completedLength, '0')
  let trackerResult
  for (let attempt = 0; attempt < 50; attempt++) { try { trackerResult = await rpc('aria2.getBtTrackers', [gid]); break } catch { await sleep(50) } }
  assert.deepEqual(trackerResult, [])
  const trackers = [{ url: 'http://127.0.0.1:9/announce', tier: 2 }]
  assert.equal(await rpc('aria2.replaceBtTrackers', [gid, trackers]), gid)
  const pausedSnapshot = await rpc('aria2.tellStatus', [gid])
  trackerResult = await rpc('aria2.getBtTrackers', [gid])
  assert.deepEqual(pausedSnapshot.bittorrent.announceList, [[trackers[0].url]])
  t.diagnostic(JSON.stringify({ phase: pausedSnapshot.status, btState: pausedSnapshot.bittorrent.state, announceListCounts: pausedSnapshot.bittorrent.announceList?.map(tier => tier.length), trackerTelemetryCount: trackerResult.length }))
  const seeds = ['http://127.0.0.1:9/files/']
  let webSeedResult
  try { webSeedResult = await rpc('aria2.replaceBtWebSeeds', [gid, seeds]) } catch (error) { t.diagnostic(error.message) }
  assert.equal(webSeedResult, gid)
  assert.deepEqual((await rpc('aria2.tellStatus', [gid])).bittorrent.webSeeds, seeds)
  await rpc('aria2.changeOption', [gid, { 'seed-ratio': '2', 'seed-time': '12', 'max-upload-limit': '65536', 'enable-peer-exchange': 'false' }])
  const options = await rpc('aria2.getOption', [gid])
  for (const [key, value] of Object.entries({ 'seed-ratio': '2', 'seed-time': '12', 'max-upload-limit': '65536', 'enable-peer-exchange': 'false' })) assert.equal(options[key], value)
  t.diagnostic(JSON.stringify({ options: Object.fromEntries(['seed-ratio', 'seed-time', 'max-upload-limit', 'enable-peer-exchange'].map(key => [key, options[key]])), webSeedCount: seeds.length }))
  assert.deepEqual(await rpc('aria2.addBtPeers', [gid, ['127.0.0.1:9']]), { added: 1, failed: 0 })
  assert.ok(Array.isArray(await rpc('aria2.getPeers', [gid])))
  // There is no RPC unset-option operation. Readmit the same GID, omitting
  // seed-time, to restore the true unlimited-time policy without fake infinity.
  assert.equal(await rpc('aria2.forceRemove', [gid]), gid)
  let admissionAbsent = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await rpc('aria2.tellStatus', [gid])).status === 'removed') break }
    catch (error) { if (!error.taskNotFound) throw error; admissionAbsent = true; break }
    await sleep(50)
  }
  if (!admissionAbsent) assert.equal(await rpc('aria2.removeDownloadResult', [gid]), 'OK')
  assert.equal(await rpc('aria2.addTorrent', [torrent.toString('base64'), seeds, { gid, pause: 'true', 'seed-ratio': '2', 'max-upload-limit': '65536', 'enable-peer-exchange': 'false' }]), gid)
  const replayed = await rpc('aria2.getOption', [gid])
  assert.equal(replayed['seed-time'], undefined)
  assert.equal(replayed['seed-ratio'], '2')
  assert.equal(replayed['max-upload-limit'], '65536')
  assert.equal(replayed['enable-peer-exchange'], 'false')
  assert.deepEqual((await rpc('aria2.tellStatus', [gid])).bittorrent.webSeeds, seeds)
  t.diagnostic(`sameGIDReplayClearedSeedTime=true; forceRemove=gid; admissionAbsent=${admissionAbsent}; addTorrent=originalGID`)
  for (const encryption of ['required', 'disabled', 'preferred']) {
    assert.equal(await rpc('aria2.changeGlobalOption', [{ 'bt-encryption': encryption }]), 'OK')
    assert.equal((await rpc('aria2.getGlobalOption'))['bt-encryption'], encryption)
  }
  assert.equal((await rpc('aria2.tellStatus', [gid])).status, 'paused')
})
