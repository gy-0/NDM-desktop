import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { auxiliaryProxyPlan, auxiliaryProxyEnvironment, WindowsProxyOperationGate } from '../src/main/windows/auxiliaryProxy.ts'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

test('auxiliary proxy selection validates endpoints, preserves SOCKS precedence and strips inherited bypass routes', () => {
  const both = { httpProxyEnabled: true, httpProxyHost: 'http.test', httpProxyPort: 80, socksProxyEnabled: true, socksProxyHost: '::1', socksProxyPort: 1080 }
  const plan = auxiliaryProxyPlan(both)
  assert.deepEqual(plan, { kind: 'socks5', url: 'socks5://[::1]:1080/' })
  assert.deepEqual(auxiliaryProxyEnvironment({ PATH: 'keep', HTTPS_PROXY: 'private', http_proxy: 'private', Ftp_Proxy: 'private', SFTP_PROXY: 'private', ALL_PROXY: 'private', No_Proxy: '*' }, plan), { PATH: 'keep', ALL_PROXY: 'socks5h://[::1]:1080/' })
  assert.deepEqual(auxiliaryProxyEnvironment({ PATH: 'keep', NO_PROXY: '*', ALL_PROXY: 'private' }, auxiliaryProxyPlan({})), { PATH: 'keep' })
  for (const host of ['', 'https://proxy', 'user:password@host', 'host/path', 'host?token=private', 'a\n--bad', '::invalid', 'host:80']) {
    assert.throws(() => auxiliaryProxyPlan({ httpProxyEnabled: true, httpProxyHost: host, httpProxyPort: 80 }), error => error.code === 'proxyUnavailable' && !error.message.includes('private'))
  }
})

test('proxy write gate waits for old admission and prevents late resume while preserving concurrent reads', async () => {
  const gate = new WindowsProxyOperationGate(), events = []
  let releaseOne, releaseTwo, releaseWriter
  const first = gate.run(false, async () => { events.push('read1'); await new Promise(resolve => { releaseOne = resolve }) })
  const second = gate.run(false, async () => { events.push('read2'); await new Promise(resolve => { releaseTwo = resolve }) })
  await delay(0); assert.deepEqual(events, ['read1','read2'])
  const writer = gate.run(true, async () => { events.push('stop'); await new Promise(resolve => { releaseWriter = resolve }); events.push('settings') })
  const later = gate.run(false, async () => { events.push('resume') })
  releaseOne(); await delay(0); assert.deepEqual(events, ['read1','read2'])
  releaseTwo(); await delay(0); assert.deepEqual(events, ['read1','read2','stop'])
  releaseWriter(); await Promise.all([first,second,writer,later]); assert.deepEqual(events, ['read1','read2','stop','settings','resume'])
})

const binary = join(process.cwd(), 'native/Vendor/Tools/aria2-next')
test('real pinned helper switches Windows TS SFTP HTTP to SOCKS5 to off with same GID, partial resume and safe ED2K receipt', {
  skip: process.env.NDM_RUN_AUXILIARY_REAL !== '1' || !process.env.NDM_SFTP_FIXTURE_PYTHON || process.platform !== 'darwin' || !existsSync(binary), timeout: 45000
}, async t => {
  // Dynamic import leaves the independent CLI's main guard and file ownership intact.
  const { LocalAuxiliaryProxy, startReadOnlySFTPFixture } = await import(pathToFileURL(join(process.cwd(), 'scripts/qa-auxiliary-proxy.mjs')).href)
  const fixture = await startReadOnlySFTPFixture(process.env.NDM_SFTP_FIXTURE_PYTHON)
  const http = await new LocalAuxiliaryProxy({ ports: [Number(new URL(fixture.url).port)] }).start()
  const socks = await new LocalAuxiliaryProxy({ ports: [Number(new URL(fixture.url).port)] }).start()
  const root = await mkdtemp(join(tmpdir(), 'ndm-win-proxy-real-')), destination = join(root, 'downloads'); await mkdir(destination)
  const engine = new WindowsDownloadEngine({ stateDirectory: root, defaultDownloadDirectory: destination, aria2Path: '', ytDlpPath: '', ffmpegPath: '',
    auxiliaryPath: binary, auxiliaryManifestPath: join(process.cwd(), 'native/Vendor/Tools/aria2-next-manifest.json'), auxiliaryLoopbackOnly: true, auxiliaryPeerDiscovery: false }, { onEvent() {}, onStatus() {} })
  t.after(async () => { await engine.stop(); await Promise.all([http.stop(), socks.stop(), fixture.stop()]); await rm(root, { recursive: true, force: true }) })
  assert.equal((await engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 131072, httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: http.port })).ok, true)
  const creationKey = randomUUID(), added = await engine.request('auxiliaryCreate', { creationKey, source: { kind: 'sftp', url: fixture.url, hostKeySHA256: fixture.hostKeySHA256 }, credentials: { username: fixture.username, password: fixture.password }, autoStart: true })
  assert.equal(added.ok, true)
  const journalPath = join(root, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  const originalGID = JSON.parse(await readFile(journalPath, 'utf8')).gid
  async function progress(minimum) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      const result = await engine.request('auxiliaryStatus', { taskID: added.taskID })
      assert.notEqual(result.snapshot.phase, 'error', 'Synthetic SFTP transfer must stay inspectable')
      if (result.snapshot.completedBytes > minimum) return result.snapshot
      await delay(100)
    }
    assert.fail('Timed out waiting for bounded SFTP progress')
  }
  const first = await progress(65536); assert(first.completedBytes < fixture.bytes)
  assert(http.routes.some(route => route.kind === 'connect' && route.bytesDown > 0))
  const child1 = engine.auxiliaryDaemon.child
  const change = await engine.request('updateSettings', { socksProxyEnabled: true, socksProxyHost: '127.0.0.1', socksProxyPort: socks.port })
  assert.equal(change.ok, true); assert(child1.exitCode !== null || child1.signalCode !== null)
  assert.equal(engine.auxiliaryDaemon.peekRPC(), null)
  const paused = (await engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot
  assert.equal(paused.phase, 'paused'); assert.equal(paused.errorCode, 'proxyChanged')
  const beforeSocksEvents = (await fixture.events()).length
  assert.equal((await engine.request('resume', { taskID: added.taskID })).ok, true)
  const rpc = engine.auxiliaryDaemon.peekRPC()
  const global = await rpc.call('aria2.getGlobalOption')
  assert.equal(global['bt-proxy'], `socks5://127.0.0.1:${socks.port}/`)
  assert.equal(global['enable-dht'], 'false'); assert.equal(global['bt-enable-lpd'], 'false'); assert.equal(global['bt-port-mapping'], 'false')
  assert.equal((await rpc.call('aria2.getOption', [originalGID]))['all-proxy'] ?? '', '')
  const second = await progress(first.completedBytes + 65536); assert(second.completedBytes < fixture.bytes)
  assert(socks.routes.some(route => route.kind === 'socks5' && route.bytesDown > 0))
  const newReads = (await fixture.events()).slice(beforeSocksEvents).filter(event => event.event === 'read')
  assert(newReads.length && newReads[0].offset > 0, 'Resume must seek past retained bytes')
  const denied = await engine.request('auxiliaryCreate', { creationKey: randomUUID(), source: { kind: 'ed2k', url: `ed2k://|file|blocked.bin|4|${'3'.repeat(32)}|sources,127.0.0.1:9999|/` }, autoStart: true })
  assert.equal(denied.ok, true); assert.equal(denied.task.status, 'paused')
  assert.equal((await engine.request('auxiliaryStatus', { taskID: denied.taskID })).snapshot.errorCode, 'proxyUnsupported')
  const child2 = engine.auxiliaryDaemon.child
  await engine.request('updateSettings', { httpProxyEnabled: false, socksProxyEnabled: false })
  assert(child2.exitCode !== null || child2.signalCode !== null)
  const routeCount = http.routes.length + socks.routes.length
  await engine.request('resume', { taskID: added.taskID })
  assert.equal((await engine.auxiliaryDaemon.peekRPC().call('aria2.getGlobalOption'))['bt-proxy'] ?? '', '')
  const deadline = Date.now() + 15000
  let completed
  while (Date.now() < deadline) { completed = (await engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot; if (completed.phase === 'complete') break; await delay(100) }
  assert.equal(completed.phase, 'complete')
  assert.equal(http.routes.length + socks.routes.length, routeCount, 'Turning proxy off must not reuse previous proxy sockets')
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).gid, originalGID)
  assert.equal((await engine.request('getCreationReceipt', { creationKey })).receipt.taskID, added.taskID)
  const task = (await engine.request('list')).tasks.find(task => task.id === added.taskID)
  const bytes = await readFile(join(task.folderPath, task.filename))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256)
  for (const path of [journalPath, join(root, 'state.json')]) {
    const persisted = await readFile(path, 'utf8'); assert(!persisted.includes(fixture.username)); assert(!persisted.includes(fixture.password))
  }
  console.log(JSON.stringify({ windowsTSProxy: { sameTaskAndGID: true, httpToSOCKS5ToOff: true, retainedPartialOffset: newReads[0].offset, byteExact: bytes.length, ed2kPausedReceipt: true, oldChildrenExited: true } }))
})

test('ED2K streaming hash matches independent OpenSSL vectors including exact-part empty suffix', async () => {
  const { ED2KHash } = await import('../src/main/windows/ed2kIntegrity.ts')
  const vectors = [[0,'31d6cfe0d16ae931b73c59d7e0c089c0'],[1,'bde52cb31de33e46245e05fbdbd6fb24'],[9727999,'5461275e76837a313a0b2f67811c1023'],[9728000,'ee15063dd1e9c5bd5c0e4205c0b8e698'],[9728001,'748c0171a2d42d28afb644ef3e17f4e7'],[19456000,'fcca57f6ae31dcfa2ce0e41119738eb1']]
  const buffer = Buffer.alloc(65537, 0x61)
  for (const [length, expected] of vectors) {
    const hash = await ED2KHash.create()
    for (let remaining = length; remaining > 0; remaining -= Math.min(remaining, buffer.length)) hash.update(buffer.subarray(0, Math.min(remaining, buffer.length)))
    assert.equal(hash.hex(), expected, `ED2K ${length} bytes`)
  }
})
