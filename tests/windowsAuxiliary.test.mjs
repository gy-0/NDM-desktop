import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
import { WindowsAuxiliaryTransfer, safeAuxiliaryPath, auxiliaryFileIdentity, validPublishedArtifact } from '../src/main/windows/auxiliaryTransfer.ts'
import { WindowsAuxiliaryDaemon } from '../src/main/windows/auxiliaryDaemon.ts'
import { WindowsAuxiliaryRPCError } from '../src/main/windows/auxiliaryRpc.ts'

const pin = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`
const source = { kind: 'magnet', url: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function fakeDaemon() {
  const rows = new Map(), calls = []
  let loseAdd = false, loseBTOptionACK = false, loseLimitACK = false, running = false, globalCap = 0, encryption = 'preferred'
  const daemon = {
    rows, calls, set loseAdd(value) { loseAdd = value }, set loseBTOptionACK(value) { loseBTOptionACK = value }, set loseLimitACK(value) { loseLimitACK = value },
    start: async () => { running = true; return { bittorrent: true, ed2k: true, sftp: true, fileSelection: true, stopSeeding: true } },
    peekRPC: () => running ? rpc : null,
    suspend: async () => { calls.push({ op: 'daemon.suspend', args: [] }); running = false; rows.clear() },
    stop: async () => { running = false }, rpc: async () => rpc
  }
  const rpc = { call: async (op, args = []) => {
      calls.push({ op, args: structuredClone(args) })
      if (op === 'aria2.getGlobalOption') return { 'max-overall-download-limit': String(globalCap), 'bt-encryption': encryption }
      if (op === 'aria2.changeGlobalOption') { if (args[0]['max-overall-download-limit'] !== undefined) globalCap = Number(args[0]['max-overall-download-limit']); if (args[0]['bt-encryption']) encryption = args[0]['bt-encryption']; return 'OK' }
      if (op === 'aria2.getGlobalStat') return { numActive: String([...rows.values()].filter(row => row.status === 'active').length), numWaiting: String([...rows.values()].filter(row => ['waiting', 'paused'].includes(row.status)).length) }
      if (op === 'aria2.tellActive') return [...rows.values()].filter(row => row.status === 'active')
      if (op === 'aria2.tellWaiting') return [...rows.values()].filter(row => ['waiting', 'paused'].includes(row.status))
      if (op === 'aria2.addUri' || op === 'aria2.addTorrent') {
        const options = args[op === 'aria2.addUri' ? 1 : 2]
        const journal = JSON.parse(await readFile(join(options.dir, '..', 'transfer.json'), 'utf8'))
        assert.equal(journal.gid, options.gid, 'GID is durable before first RPC')
        assert.equal(rows.has(options.gid), false, 'fixed GID must not be blindly added twice')
        rows.set(options.gid, { gid: options.gid, status: 'paused', totalLength: '4', completedLength: '0', downloadSpeed: '0', uploadSpeed: '0',
          options: { 'seed-ratio': '1.0', 'max-upload-limit': '0', 'enable-peer-exchange': 'true', ...options },
          ...(options['pause-metadata'] ? { bittorrent: { state: 'paused', announceList: [], webSeeds: op === 'aria2.addTorrent' ? args[1] : [], info: { name: 'fixture.bin' } } } : {}),
          files: [{ index: '1', path: join(options.dir, 'fixture.bin'), length: '4', completedLength: '0', selected: 'true' }] })
        if (loseAdd) { loseAdd = false; throw new WindowsAuxiliaryRPCError('unavailable') }
        return options.gid
      }
      const row = rows.get(args[0])
      if (!row) throw new WindowsAuxiliaryRPCError('notFound')
      if (op === 'aria2.tellStatus') return structuredClone(row)
      if (op === 'aria2.getOption') return structuredClone(row.options)
      if (op === 'aria2.getBtTrackers') return row.trackerTelemetry ?? []
      if (op === 'aria2.getPeers') return row.peers ?? []
      if (op === 'aria2.replaceBtTrackers') { const tiers = [...new Set(args[1].map(item => item.tier))].sort((a,b)=>a-b); row.bittorrent.announceList = tiers.map(tier => args[1].filter(item => item.tier === tier).map(item => item.url)); return row.gid }
      if (op === 'aria2.replaceBtWebSeeds') { row.bittorrent.webSeeds = [...args[1]]; return row.gid }
      if (op === 'aria2.addBtPeers') return { added: args[1].length, failed: 0 }
      if (op === 'aria2.unpause') { row.status = 'active'; return row.gid }
      if (op === 'aria2.forcePause') { row.status = 'paused'; if (row.bittorrent) row.bittorrent.state = 'paused'; return row.gid }
      if (op === 'aria2.forceRemove' || op === 'aria2.removeDownloadResult') { rows.delete(row.gid); return row.gid }
      if (op === 'aria2.changeOption') { Object.assign(row.options, args[1]); if (args[1]['max-download-limit'] && loseLimitACK) { loseLimitACK = false; throw new WindowsAuxiliaryRPCError('unavailable') } if (args[1]['seed-ratio'] && loseBTOptionACK) { loseBTOptionACK = false; throw new WindowsAuxiliaryRPCError('unavailable') } if (args[1]['select-file']) for (const file of row.files) file.selected = args[1]['select-file'].split(',').includes(file.index) ? 'true' : 'false'; return 'OK' }
      assert.fail(`unexpected RPC ${op}`)
    }
  }
  return daemon
}
async function fixture(t, daemon = fakeDaemon()) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-auxiliary-')), destination = join(root, 'downloads')
  await mkdir(destination)
  const options = { stateDirectory: root, defaultDownloadDirectory: destination, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  const engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} })
  engine.auxiliaryDaemon = daemon
  engine.rpc.call = async () => { throw new Error('standard HTTP RPC must not be used for auxiliary tasks') }
  t.after(async () => { await engine.saveChain; await daemon.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, destination, options, engine, daemon }
}
const create = (engine, extras = {}) => engine.request('auxiliaryCreate', { creationKey: randomUUID(), source, autoStart: false, ...extras })

test('auxiliary creation shares the task ledger and receipt, registers fixed GID before RPC and preserves BT selection gate', async t => {
  const f = await fixture(t), key = randomUUID()
  const added = await create(f.engine, { creationKey: key })
  assert.equal(added.ok, true)
  assert.equal(added.task.linkType, 'bittorrent')
  const status = await f.engine.request('auxiliaryStatus', { taskID: added.taskID })
  assert.equal(status.snapshot.phase, 'awaitingSelection')
  assert.equal(f.daemon.calls.some(call => call.op === 'aria2.unpause'), false)
  const replay = await create(f.engine, { creationKey: key })
  assert.equal(replay.receipt.taskID, added.taskID)
  assert.equal(f.daemon.calls.filter(call => call.op === 'aria2.addUri').length, 1)
  const stored = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'))
  assert.equal(stored.tasks.length, 1)
  assert.equal(stored.creationReceipts.entries[0].taskID, added.taskID)
})

test('ordinary magnet add uses its existing add receipt and cannot bypass auxiliary file selection', async t => {
  const f = await fixture(t), key = randomUUID()
  const added = await f.engine.request('add', { creationKey: key, url: source.url, autoStart: true })
  assert.equal(added.task.linkType, 'bittorrent')
  assert.equal(added.task.auxiliary.phase, 'awaitingSelection')
  assert.equal((await f.engine.request('add', { creationKey: key, url: source.url, autoStart: true })).receipt.taskID, added.task.id)
  await assert.rejects(f.engine.request('add', { creationKey: randomUUID(), url: source.url, headers: ['Cookie: secret'] }), /磁力任务/)
})

test('lost add ACK and engine restart replay recover the same GID without duplicate task IDs', async t => {
  const f = await fixture(t)
  f.daemon.loseAdd = true
  const added = await create(f.engine)
  assert.equal(added.ok, true, 'creation receipt remains acknowledged even if transfer admission reply is lost')
  const firstGID = [...f.daemon.rows.keys()][0]
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'awaitingSelection')
  assert.equal(f.daemon.calls.filter(call => call.op === 'aria2.addUri').length, 1)
  f.daemon.rows.clear()
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  restarted.auxiliaryDaemon = f.daemon
  const status = await restarted.request('auxiliaryStatus', { taskID: added.taskID })
  assert.equal(status.snapshot.phase, 'awaitingSelection')
  assert.deepEqual([...f.daemon.rows.keys()], [firstGID])
  assert.equal((await restarted.request('list')).tasks.length, 1)
})

test('file selection requires generation and nonempty manifest selection and confirms pause before changing options', async t => {
  const f = await fixture(t), added = await create(f.engine)
  await assert.rejects(f.engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 99, indices: [1], autoStart: true }), /代次/)
  await assert.rejects(f.engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [], autoStart: true }), /至少/)
  ;[...f.daemon.rows.values()][0].status = 'active'
  const result = await f.engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [1], autoStart: true })
  assert.equal(result.snapshot.phase, 'downloading')
  const pause = f.daemon.calls.findIndex(call => call.op === 'aria2.forcePause')
  const select = f.daemon.calls.findIndex(call => call.op === 'aria2.changeOption' && call.args[1]['select-file'])
  assert.ok(pause >= 0 && select > pause)
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.generation, 1)
})

test('seeding remains active until stopped, publishes verified payload without overwriting user file, and preserves replacement ownership', async t => {
  const f = await fixture(t), added = await create(f.engine)
  await f.engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [1], autoStart: true })
  const row = [...f.daemon.rows.values()][0]
  await writeFile(row.files[0].path, 'data')
  row.completedLength = '4'; row.files[0].completedLength = '4'; row.bittorrent.state = 'seeding'; row.uploadSpeed = '12'
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'seeding')
  assert.equal((await f.engine.request('list')).tasks[0].status, 'downloading')
  await writeFile(join(f.destination, 'fixture.bin'), 'keep existing')
  await f.engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  const task = (await f.engine.request('list')).tasks[0]
  assert.equal(task.status, 'complete')
  assert.notEqual(task.filename, 'fixture.bin')
  assert.equal(await readFile(join(task.folderPath, task.filename), 'utf8'), 'data')
  assert.equal(await readFile(join(f.destination, 'fixture.bin'), 'utf8'), 'keep existing')
  await rm(join(task.folderPath, task.filename)); await writeFile(join(task.folderPath, task.filename), 'user replaced it')
  await assert.rejects(f.engine.request('remove', { taskID: task.id, deleteFile: true }), /被更换/)
  assert.equal(await readFile(join(task.folderPath, task.filename), 'utf8'), 'user replaced it')
})

test('SFTP credentials are volatile, status remains inspectable after restart, and authentication resumes the original task and pin', async t => {
  const f = await fixture(t)
  const added = await create(f.engine, { source: { kind: 'sftp', url: 'sftp://server.test/fixture.bin', hostKeySHA256: pin }, credentials: { username: 'fixture-private-user', password: 'fixture-private-password' }, autoStart: false })
  const files = [join(f.root, 'state.json'), join(f.root, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')]
  for (const path of files) assert.ok(!(await readFile(path, 'utf8')).includes('fixture-private'))
  f.daemon.rows.clear()
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  restarted.auxiliaryDaemon = f.daemon
  const missing = await restarted.request('auxiliaryStatus', { taskID: added.taskID })
  assert.equal(missing.snapshot.kind, 'sftp'); assert.equal(missing.snapshot.phase, 'error')
  const auth = await restarted.request('auxiliaryAuthenticate', { taskID: added.taskID, generation: 1, credentials: { username: 'fixture-private-user', password: 'fixture-new-password' }, autoStart: true })
  assert.equal(auth.snapshot.phase, 'downloading')
  assert.equal((await restarted.request('list')).tasks.length, 1)
  assert.ok(!(await readFile(files[0], 'utf8')).includes('fixture-private'))
  const options = f.daemon.calls.filter(call => call.op === 'aria2.addUri').at(-1).args[1]
  assert.equal(options['ssh-host-key-sha256'], pin.slice(7) + '=')
})

test('unsafe helper paths and symlinks never become public completed files', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const row = [...f.daemon.rows.values()][0]
  row.files[0].path = join(f.root, 'outside.txt')
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'error')
  if (process.platform !== 'win32') {
    const root = join(f.root, 'safe'); await mkdir(root); await symlink(f.destination, join(root, 'escape'))
    await assert.rejects(safeAuxiliaryPath(root, 'escape/file.bin'), /所有权/)
  }
})

test('state write failure prevents auxiliary RPC admission and leaves no phantom task receipt', async t => {
  const f = await fixture(t)
  f.engine.writeState = async () => { throw new Error('disk full') }
  await assert.rejects(create(f.engine), /disk full/)
  assert.equal(f.daemon.calls.length, 0)
  assert.deepEqual((await f.engine.request('list')).tasks, [])
})

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return bencode(Buffer.from(value))
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}
const realBinary = join(process.cwd(), 'native/Vendor/Tools/aria2-next')
test('pinned real helper on macOS exercises Windows TS torrent admission, selection, same-GID restart and local payload delivery', { skip: process.env.NDM_RUN_AUXILIARY_REAL !== '1' || process.platform !== 'darwin' || !existsSync(realBinary), timeout: 45000 }, async t => {
  const payload = Buffer.from('NDM bounded torrent fixture payload')
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
    const body = payload.subarray(start, end + 1)
    res.writeHead(range ? 206 : 200, { 'content-length': body.length, 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {}) }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-real-aux-'))
  const daemonOptions = { binaryPath: realBinary, manifestPath: join(process.cwd(), 'native/Vendor/Tools/aria2-next-manifest.json'), stateDirectory: join(root, 'helper'), loopbackOnly: true, peerDiscovery: false }
  let daemon = new WindowsAuxiliaryDaemon(daemonOptions)
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }) })
  assert.equal((await daemon.start()).bittorrent, true)
  const torrent = bencode({ 'url-list': `http://127.0.0.1:${server.address().port}/fixture.bin`, info: { name: 'fixture.bin', length: payload.length, 'piece length': 16384, pieces: createHash('sha1').update(payload).digest() } })
  const options = { stateDirectory: join(root, 'app'), defaultDownloadDirectory: join(root, 'downloads'), aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  await mkdir(options.stateDirectory); await mkdir(options.defaultDownloadDirectory)
  let engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); engine.auxiliaryDaemon = daemon
  const added = await create(engine, { source: { kind: 'torrent', torrentData: torrent.toString('base64') } })
  if (added.task.auxiliary.phase === 'error') await (await engine.auxiliaryTransfer(engine.tasks[0])).status()
  assert.equal(added.task.auxiliary.phase, 'awaitingSelection')
  const path = join(options.stateDirectory, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  const gid = JSON.parse(await readFile(path, 'utf8')).gid
  await daemon.stop()
  daemon = new WindowsAuxiliaryDaemon(daemonOptions)
  engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); engine.auxiliaryDaemon = daemon
  assert.equal((await engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'awaitingSelection')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).gid, gid)
  await engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [1], autoStart: true })
  let status
  const deadline = Date.now() + 20000
  do { status = await engine.request('auxiliaryStatus', { taskID: added.taskID }); if (status.snapshot.payloadCompleted) break; await delay(100) } while (Date.now() < deadline)
  assert.equal(status.snapshot.payloadCompleted, true, JSON.stringify(status))
  if (status.snapshot.phase === 'seeding') await engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  const task = (await engine.request('list')).tasks[0]
  assert.equal(task.status, 'complete')
  assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payload)
  await engine.request('remove', { taskID: task.id, deleteFile: false })
  assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payload)
  assert.deepEqual((await engine.request('list')).tasks, [])
})

const fixturePython = process.env.NDM_SFTP_FIXTURE_PYTHON
test('real SFTP via Windows TS resumes original credentials and partial bytes after helper restart without writing passwords', { skip: process.env.NDM_RUN_AUXILIARY_REAL !== '1' || !fixturePython || process.platform !== 'darwin', timeout: 60000 }, async t => {
  const child = spawn(fixturePython, ['scripts/qa-sftp-fixture.py', '--bytes', '2097152', '--delay', '0.03'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(child, 'exit')
  let metadata
  t.after(async () => { child.kill('SIGTERM'); await exited; if (metadata) await rm(metadata.root, { recursive: true, force: true }) })
  const metadataPath = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 10000)
    child.once('error', reject)
    child.stdout.on('data', chunk => { text += String(chunk); if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0]).metadataPath) } catch { reject(new Error('Invalid fixture metadata')) } } })
  })
  metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'ndm-win-real-sftp-'))
  const options = { stateDirectory: join(root, 'app'), defaultDownloadDirectory: join(root, 'downloads'), aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  await mkdir(options.stateDirectory); await mkdir(options.defaultDownloadDirectory)
  const daemonOptions = { binaryPath: realBinary, manifestPath: join(process.cwd(), 'native/Vendor/Tools/aria2-next-manifest.json'), stateDirectory: join(root, 'helper'), loopbackOnly: true, peerDiscovery: false }
  let daemon = new WindowsAuxiliaryDaemon(daemonOptions)
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }) })
  let engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); engine.auxiliaryDaemon = daemon
  const added = await create(engine, { source: { kind: 'sftp', url: metadata.url, hostKeySHA256: metadata.hostKeySHA256 }, credentials: { username: metadata.username, password: 'generated-wrong-password' }, autoStart: true })
  const waitFor = async predicate => {
    const deadline = Date.now() + 20000
    do { const result = await engine.request('auxiliaryStatus', { taskID: added.taskID }); if (predicate(result.snapshot)) return result.snapshot; await delay(60) } while (Date.now() < deadline)
    assert.fail('SFTP state did not reach the expected boundary')
  }
  await waitFor(snapshot => snapshot.phase === 'error')
  const events = () => readFile(join(metadata.root, 'events.jsonl'), 'utf8')
  assert.ok(!(await events()).includes('"event": "read"'))
  const credentials = { username: metadata.username, password: metadata.password }
  await engine.request('auxiliaryAuthenticate', { taskID: added.taskID, generation: 1, credentials, autoStart: true })
  await waitFor(snapshot => snapshot.completedBytes > 0 && snapshot.completedBytes < metadata.bytes)
  await engine.request('pause', { taskID: added.taskID })
  assert.equal((await engine.request('auxiliaryAuthenticate', { taskID: added.taskID, generation: 1, credentials, autoStart: false })).snapshot.phase, 'paused')
  const journalPath = join(options.stateDirectory, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  const gid = JSON.parse(await readFile(journalPath, 'utf8')).gid
  await daemon.stop()
  const resumeEventOffset = (await events()).trim().split('\n').length
  const scan = async path => { for (const item of await readdir(path, { withFileTypes: true })) { const file = join(path, item.name); if (item.isDirectory()) await scan(file); else { const bytes = await readFile(file); assert.equal(bytes.includes(Buffer.from(metadata.password)), false, 'Password must not persist in app or helper state'); assert.equal(bytes.includes(Buffer.from('generated-wrong-password')), false) } } }
  await scan(root)
  daemon = new WindowsAuxiliaryDaemon(daemonOptions)
  engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); engine.auxiliaryDaemon = daemon
  assert.equal((await engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'error')
  await engine.request('auxiliaryAuthenticate', { taskID: added.taskID, generation: 1, credentials, autoStart: true })
  await writeFile(join(options.defaultDownloadDirectory, 'fixture.bin'), 'existing user file')
  await waitFor(snapshot => snapshot.phase === 'complete')
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).gid, gid)
  const task = (await engine.request('list')).tasks[0]
  assert.equal(task.id, added.taskID); assert.equal(task.status, 'complete')
  assert.equal(createHash('sha256').update(await readFile(join(task.folderPath, task.filename))).digest('hex'), metadata.sha256)
  const resumedReads = (await events()).trim().split('\n').slice(resumeEventOffset).map(line => JSON.parse(line)).filter(item => item.event === 'read')
  assert.ok(resumedReads.length > 0 && resumedReads[0].offset > 0, 'New helper must resume from persisted partial data')
  assert.equal(await readFile(join(options.defaultDownloadDirectory, 'fixture.bin'), 'utf8'), 'existing user file')
  await daemon.stop(); await scan(root)
  const restored = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} }); restored.auxiliaryDaemon = daemon
  assert.equal((await restored.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'complete', 'Published artifact recovers without credentials or helper')
})


test('metadata with no payload path is valid; unknown SFTP lengths are not reported as completed', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const row = [...f.daemon.rows.values()][0]
  row.bittorrent = { state: 'downloadingMetadata' }; row.files[0].path = ''; row.totalLength = '0'
  const metadata = await f.engine.request('auxiliaryStatus', { taskID: added.taskID })
  assert.equal(metadata.snapshot.phase, 'metadata'); assert.deepEqual(metadata.snapshot.files, [])
  const sftp = await create(f.engine, { source: { kind: 'sftp', url: 'sftp://server.test/fixture.bin', hostKeySHA256: pin }, credentials: { username: 'fixture', password: 'secret' } })
  const sftpRow = [...f.daemon.rows.values()][1]
  sftpRow.status = 'active'; sftpRow.totalLength = '0'; sftpRow.completedLength = '2'; sftpRow.files[0].length = '0'; sftpRow.files[0].completedLength = '2'
  const partial = await f.engine.request('auxiliaryStatus', { taskID: sftp.taskID })
  assert.equal(partial.snapshot.phase, 'downloading'); assert.equal(partial.snapshot.completedBytes, 2); assert.equal(partial.snapshot.totalBytes, 0); assert.equal(partial.snapshot.payloadCompleted, false)
})

test('replaced work directories cannot be replayed or cleaned, including from an already cached transfer', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const work = join(f.root, 'auxiliary-tasks', String(added.taskID), '1')
  await rename(work, work + '-original'); await mkdir(join(work, 'files'), { recursive: true }); await writeFile(join(work, 'files', 'user.bin'), 'preserve me')
  const callsBefore = f.daemon.calls.length
  await assert.rejects(f.engine.request('remove', { taskID: added.taskID, deleteFile: false }), /被更换/)
  assert.equal(await readFile(join(work, 'files', 'user.bin'), 'utf8'), 'preserve me')
  assert.equal(f.daemon.calls.length, callsBefore)
  assert.equal((await f.engine.request('list')).tasks.length, 1)
})

test('ED2K completed payload keeps sharing status until pause is confirmed, then publishes', async t => {
  const f = await fixture(t), added = await create(f.engine, { source: { kind: 'ed2k', url: `ed2k://|file|fixture.bin|4|539080ba278cf4cf4db2e4a32642ff30|sources,127.0.0.1:4662|/` }, autoStart: true })
  const row = [...f.daemon.rows.values()][0]
  await writeFile(row.files[0].path, 'data'); row.completedLength = '4'; row.files[0].completedLength = '4'; row.seeder = 'true'
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'seeding')
  await f.engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  const task = (await f.engine.request('list')).tasks[0]
  assert.equal(task.status, 'complete'); assert.equal(await readFile(join(task.folderPath, task.filename), 'utf8'), 'data')
})


test('actual add/unpause paths split the total before RPC admission and preserve task GID when a one-byte budget cannot be shared', async t => {
  const f = await fixture(t), rows = new Map(), writes = []
  let cap = 0
  f.engine.primaryReady = true
  f.engine.rpc.call = async (method, args = []) => {
    if (method === 'getGlobalOption') return { 'max-overall-download-limit': String(cap) }
    if (method === 'changeGlobalOption') { cap = Number(args[0]['max-overall-download-limit']); writes.push(cap); return 'OK' }
    if (method === 'getGlobalStat') return { numActive: String([...rows.values()].filter(row => row.status === 'active').length), numWaiting: String([...rows.values()].filter(row => row.status === 'paused').length) }
    if (method === 'tellWaiting') return [...rows.values()].filter(row => row.status === 'paused')
    if (method === 'addUri') { const gid = String(rows.size + 1); rows.set(gid, { gid, status: 'active' }); return gid }
    if (method === 'forcePause') { rows.get(args[0]).status = 'paused'; return args[0] }
    if (method === 'unpause') { rows.get(args[0]).status = 'active'; return args[0] }
    if (method === 'tellStatus') { const row = rows.get(args[0]); return { ...row, totalLength: '100', completedLength: '0', downloadSpeed: '0', files: [] } }
    assert.fail(`Unexpected primary method ${method}`)
  }
  await f.engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 1024 })
  const primary = await f.engine.request('add', { url: 'http://fixture.test/payload.bin' })
  assert.equal(cap, 1024)
  const aux = await create(f.engine, { source: { kind: 'sftp', url: 'sftp://fixture.test/fixture.bin', hostKeySHA256: pin }, credentials: { username: 'fixture', password: 'synthetic' }, autoStart: true })
  assert.equal(cap, 512)
  assert.equal((await f.daemon.peekRPC().call('aria2.getGlobalOption'))['max-overall-download-limit'], '512')
  const admission = f.daemon.calls.findIndex(call => call.op === 'aria2.unpause')
  assert.ok(f.daemon.calls.slice(0, admission).some(call => call.op === 'aria2.changeGlobalOption' && call.args[0]['max-overall-download-limit'] === '512'))
  await f.engine.request('pause', { taskID: primary.task.id })
  await f.engine.poll()
  assert.equal((await f.daemon.peekRPC().call('aria2.getGlobalOption'))['max-overall-download-limit'], '1024', 'Paused reserved requests do not consume a share')
  await f.engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 1 })
  const originalGID = f.engine.tasks.find(task => task.id === primary.task.id).gid
  await assert.rejects(f.engine.request('resume', { taskID: primary.task.id }), /至少/)
  assert.equal(f.engine.tasks.find(task => task.id === primary.task.id).gid, originalGID)
  assert.equal(rows.size, 1)
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: aux.taskID })).snapshot.phase, 'downloading')
})


const btConfig = (changes = {}) => ({ trackers: [{ url: 'https://tracker.test/announce?passkey=synthetic', tier: 0 }], webSeeds: ['https://seed.test/fixture.bin'], seedRatio: 2, seedMinutes: 12, uploadLimit: 65536, peerExchange: false, ...changes })
test('BT config uses paused RPC writes plus authoritative readback, typed telemetry and revision checks', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const binding = { taskID: added.taskID, generation: 1 }
  const initial = await f.engine.request('auxiliaryBTStatus', binding)
  assert.equal(initial.state.config.seedMinutes, null); assert.equal(initial.state.config.seedRatio, 1)
  const changed = await f.engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 0, config: btConfig() })
  assert.equal(changed.ok, true); assert.equal(changed.state.revision, 1); assert.deepEqual(changed.state.config, btConfig())
  assert.deepEqual(changed.state.trackers, [], 'Tracker telemetry can be empty while authoritative configuration is present')
  assert.equal(f.daemon.calls.some(call => call.op === 'aria2.unpause'), false)
  assert.equal((await f.engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 0, config: btConfig() })).code, 'conflict')
  assert.equal((await f.engine.request('auxiliaryBTStatus', { ...binding, generation: 2 })).code, 'staleGeneration')
  const row = [...f.daemon.rows.values()][0]
  row.trackerTelemetry = [{ url: btConfig().trackers[0].url, tier: '0', status: 'notAnnounced', failures: '0', seeders: '-1', leechers: '-1' }]
  row.peers = [{ ip: '127.0.0.1', port: '4662', downloadSpeed: '1024', uploadSpeed: '0', progress: '0.5', seeder: 'false', state: 'connected', encryption: 'plaintext' }]
  const measured = await f.engine.request('auxiliaryBTStatus', binding)
  assert.equal(measured.state.peers[0].downloadSpeed, 1024); assert.equal(measured.state.trackers[0].seeders, -1)
  assert.deepEqual(await f.engine.request('auxiliaryBTAddPeers', { ...binding, peers: ['127.0.0.1:1234'] }), { ok: true, added: 1, failed: 0 })
})

test('clearing seed-time rebuilds the paused original GID without empty options, deleting bytes or losing selection', async t => {
  const f = await fixture(t), added = await create(f.engine), binding = { taskID: added.taskID, generation: 1 }
  await f.engine.request('auxiliarySelectFiles', { ...binding, indices: [1], autoStart: false })
  const row = [...f.daemon.rows.values()][0]; await writeFile(row.files[0].path, 'part')
  assert.equal((await f.engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 0, config: btConfig() })).ok, true)
  const result = await f.engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 1, config: btConfig({ seedMinutes: null }) })
  assert.equal(result.ok, true); assert.equal(result.state.revision, 2); assert.equal(result.state.config.seedMinutes, null)
  assert.deepEqual([...f.daemon.rows.keys()], [row.gid]); assert.equal(await readFile(row.files[0].path, 'utf8'), 'part')
  const replay = f.daemon.calls.filter(call => call.op === 'aria2.addUri').at(-1).args[1]
  assert.equal(Object.hasOwn(replay, 'seed-time'), false); assert.equal(replay['select-file'], '1'); assert.equal(replay.pause, 'true')
  assert.equal(f.daemon.calls.some(call => call.op === 'aria2.unpause'), false)
})

test('lost BT config ACK keeps a durable pending intent and resolves it on status or same-GID restart', async t => {
  const f = await fixture(t), added = await create(f.engine), binding = { taskID: added.taskID, generation: 1 }
  f.daemon.loseBTOptionACK = true
  assert.equal((await f.engine.request('auxiliaryBTConfigure', { ...binding, expectedRevision: 0, config: btConfig() })).code, 'unconfirmed')
  const path = join(f.root, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  const pending = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(pending.bt.revision, 0); assert.deepEqual(pending.bt.pending.config, btConfig())
  f.daemon.rows.clear()
  const restarted = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} }); restarted.auxiliaryDaemon = f.daemon
  const result = await restarted.request('auxiliaryBTStatus', binding)
  assert.equal(result.ok, true); assert.equal(result.state.revision, 1); assert.deepEqual(result.state.config, btConfig())
  assert.deepEqual([...f.daemon.rows.keys()], [pending.gid]); assert.equal(JSON.parse(await readFile(path, 'utf8')).bt.pending, undefined)
})

test('BT encryption changes the actual shared session, persists revisions and requires all BT transfers paused', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const state = await f.engine.request('auxiliaryBTGlobalStatus')
  assert.deepEqual(state, { ok: true, state: { revision: 0, encryption: 'preferred', canConfigure: true } })
  const changed = await f.engine.request('auxiliaryBTGlobalConfigure', { expectedRevision: 0, encryption: 'required' })
  assert.equal(changed.state.encryption, 'required'); assert.equal(changed.state.revision, 1)
  assert.equal((await f.daemon.peekRPC().call('aria2.getGlobalOption'))['bt-encryption'], 'required')
  assert.equal(JSON.parse(await readFile(join(f.root, 'bt-global.json'), 'utf8')).encryption, 'required')
  await f.engine.request('auxiliarySelectFiles', { taskID: added.taskID, generation: 1, indices: [1], autoStart: true })
  assert.equal((await f.engine.request('auxiliaryBTGlobalConfigure', { expectedRevision: 1, encryption: 'disabled' })).code, 'allTasksMustPause')
  assert.equal((await f.engine.request('auxiliaryBTGlobalStatus')).state.encryption, 'required')
})


test('auxiliary budget divides active GIDs before new unpause and a lost decrease ACK cannot admit extra payload', async t => {
  const f = await fixture(t)
  await f.engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 1024 })
  const credentials = { username: 'fixture', password: 'synthetic' }
  const first = await create(f.engine, { source: { kind: 'sftp', url: 'sftp://fixture.test/one.bin', hostKeySHA256: pin }, credentials, autoStart: true })
  const firstRow = [...f.daemon.rows.values()][0]
  assert.equal(firstRow.options['max-download-limit'], '1024')
  f.daemon.loseLimitACK = true
  const second = await create(f.engine, { source: { kind: 'sftp', url: 'sftp://fixture.test/two.bin', hostKeySHA256: pin }, credentials, autoStart: true })
  const secondRow = [...f.daemon.rows.values()][1]
  assert.equal(secondRow.status, 'paused'); assert.equal(firstRow.options['max-download-limit'], '512')
  assert.equal(f.daemon.calls.filter(call => call.op === 'aria2.unpause').length, 1)
  await f.engine.request('resume', { taskID: second.taskID })
  assert.equal(secondRow.options['max-download-limit'], '512'); assert.equal(secondRow.status, 'active')
  await f.engine.request('setBandwidth', { taskID: second.taskID, bandwidthLimit: 128 })
  assert.equal(secondRow.options['max-download-limit'], '128')
  assert.equal((await f.engine.request('list')).tasks.find(task => task.id === second.taskID).bandwidthLimit, 128)
  await f.engine.request('pause', { taskID: second.taskID }); await f.engine.poll()
  assert.equal(firstRow.options['max-download-limit'], '1024')
  await f.engine.request('updateSettings', { bandwidthLimitBytesPerSecond: 0 })
  assert.equal(firstRow.options['max-download-limit'], '0')
  assert.equal((await f.engine.request('list')).tasks.find(task => task.id === first.taskID).bandwidthLimit, 0)
})

test('proxy switch stops the old helper before ACK and retains receipt, GID, partial files and volatile credentials', async t => {
  const f = await fixture(t), creationKey = randomUUID()
  const added = await create(f.engine, { creationKey, source: { kind: 'sftp', url: 'sftp://server.test/fixture.bin', hostKeySHA256: pin }, credentials: { username: 'proxy-private-user', password: 'proxy-private-password' }, autoStart: true })
  const row = [...f.daemon.rows.values()][0], gid = row.gid
  await writeFile(row.files[0].path, 'part')
  let finishStop; const originalStop = f.daemon.suspend
  f.daemon.suspend = async () => { await new Promise(resolve => { finishStop = resolve }); await originalStop() }
  let acknowledged = false
  const change = f.engine.request('updateSettings', { httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: 7890 }).then(result => { acknowledged = true; return result })
  while (!finishStop) await delay(1)
  assert.equal(acknowledged, false)
  assert.equal(!!JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')).settings.httpProxyEnabled, false)
  finishStop(); assert.equal((await change).ok, true)
  const snapshot = (await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot
  assert.equal(snapshot.phase, 'paused'); assert.equal(snapshot.errorCode, 'proxyChanged'); assert.equal(f.daemon.rows.size, 0)
  assert.equal(await readFile(row.files[0].path, 'utf8'), 'part')
  assert.equal((await f.engine.request('getCreationReceipt', { creationKey })).receipt.taskID, added.taskID)
  const journalPath = join(f.root, 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json')
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).requestedRunning, false)
  assert.equal((await f.engine.request('resume', { taskID: added.taskID })).ok, true)
  assert.deepEqual([...f.daemon.rows.keys()], [gid])
  assert.equal(f.daemon.rows.get(gid).options['all-proxy'], 'http://127.0.0.1:7890/')
  assert.equal(f.daemon.rows.get(gid).options['sftp-passwd'], 'proxy-private-password')
  for (const path of [journalPath, join(f.root, 'state.json')]) assert.equal((await readFile(path, 'utf8')).includes('proxy-private'), false)
})

test('ED2K with a selected proxy acknowledges one paused task but never admits payload, including repeat create and resume', async t => {
  const f = await fixture(t)
  assert.equal((await f.engine.request('updateSettings', { socksProxyEnabled: true, socksProxyHost: '127.0.0.1', socksProxyPort: 1080 })).ok, true)
  const creationKey = randomUUID(), request = { creationKey, source: { kind: 'ed2k', url: `ed2k://|file|fixture.bin|4|${'1'.repeat(32)}|sources,127.0.0.1:9999|/` }, autoStart: true }
  const added = await f.engine.request('auxiliaryCreate', request)
  assert.equal(added.ok, true); assert.equal(added.task.status, 'paused')
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.errorCode, 'proxyUnsupported')
  assert.equal((await f.engine.request('auxiliaryCreate', request)).receipt.taskID, added.taskID)
  assert.equal((await f.engine.request('resume', { taskID: added.taskID })).code, 'proxyUnsupported')
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  assert.equal(f.daemon.calls.some(call => ['aria2.addUri','aria2.unpause'].includes(call.op)), false)
  await f.engine.request('updateSettings', { socksProxyEnabled: false })
  assert.equal((await f.engine.request('resume', { taskID: added.taskID })).ok, true)
})

test('failed proxy stop returns failure, preserves previous settings and cannot admit a later auxiliary task', async t => {
  const f = await fixture(t), added = await create(f.engine)
  f.daemon.suspend = async () => { throw new Error('synthetic termination failure with private detail') }
  const reply = await f.engine.request('updateSettings', { httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: 7890 })
  assert.equal(reply.ok, false); assert.equal(reply.code, 'proxyUnavailable'); assert.equal(JSON.stringify(reply).includes('private detail'), false)
  assert.equal(!!(await f.engine.request('getSettings')).settings.httpProxyEnabled, false)
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'error')
  assert.equal((await f.engine.request('resume', { taskID: added.taskID })).code, 'proxyUnavailable')
  assert.equal(f.daemon.calls.some(call => call.op === 'aria2.unpause'), false)
})

test('proxy state write failure keeps old settings and stopped tasks, then recovers without a new GID', async t => {
  const f = await fixture(t), added = await create(f.engine)
  const gid = [...f.daemon.rows.keys()][0], writeState = f.engine.writeState.bind(f.engine)
  f.engine.writeState = async () => { throw new Error('synthetic full disk') }
  await assert.rejects(f.engine.request('updateSettings', { httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: 7890 }), /full disk/)
  assert.equal(!!(await f.engine.request('getSettings')).settings.httpProxyEnabled, false)
  assert.equal(f.daemon.rows.size, 0)
  f.engine.writeState = writeState
  assert.equal((await f.engine.request('resume', { taskID: added.taskID })).ok, true)
  assert.deepEqual([...f.daemon.rows.keys()], [gid])
})

test('completed ED2K can stop sharing and publish locally after proxy switch without a new helper admission', async t => {
  const f = await fixture(t), added = await create(f.engine, { source: { kind: 'ed2k', url: `ed2k://|file|fixture.bin|4|539080ba278cf4cf4db2e4a32642ff30|/` }, autoStart: true })
  const row = [...f.daemon.rows.values()][0]
  await writeFile(row.files[0].path, 'data')
  row.completedLength = '4'; row.files[0].completedLength = '4'; row.seeder = 'true'
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'seeding')
  await f.engine.request('updateSettings', { httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: 7890 })
  const restored = new WindowsDownloadEngine(f.options, { onEvent() {}, onStatus() {} })
  restored.auxiliaryDaemon = f.daemon
  const calls = f.daemon.calls.length
  const stopped = await restored.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  assert.equal(stopped.snapshot.phase, 'complete')
  assert.equal(f.daemon.calls.length, calls, 'verified stopped payload publication must not contact the helper')
  const task = (await restored.request('list')).tasks[0]
  assert.equal(await readFile(join(task.folderPath, task.filename), 'utf8'), 'data')
  assert.equal(task.errorText, undefined)
})

test('ED2K offline publication rejects equal-length corruption and incomplete payload while preserving original bytes', async t => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t), added = await create(f.engine, { source: { kind: 'ed2k', url: 'ed2k://|file|fixture.bin|4|539080ba278cf4cf4db2e4a32642ff30|/' }, autoStart: true })
    const row = [...f.daemon.rows.values()][0]
    await writeFile(row.files[0].path, 'data')
    row.completedLength = corrupt ? '4' : '2'; row.files[0].completedLength = row.completedLength; row.seeder = corrupt ? 'true' : 'false'
    await f.engine.request('auxiliaryStatus', { taskID: added.taskID })
    await f.engine.request('updateSettings', { httpProxyEnabled: true, httpProxyHost: '127.0.0.1', httpProxyPort: 7890 })
    const calls = f.daemon.calls.length
    if (corrupt) {
      await writeFile(row.files[0].path, 'evil')
      await assert.rejects(f.engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 }), /校验值不符/)
    } else assert.equal((await f.engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })).code, 'proxyUnsupported')
    assert.equal(f.daemon.calls.length, calls)
    assert.equal(await readFile(row.files[0].path, 'utf8'), corrupt ? 'evil' : 'data')
    assert.deepEqual(await readdir(f.destination), [])
    assert.notEqual((await f.engine.request('list')).tasks[0].status, 'complete')
  }
})


test('auxiliary artifact identities preserve adjacent 64-bit NTFS IDs through JSON and accept safe legacy IDs', () => {
  const first = auxiliaryFileIdentity({ dev: 1n, ino: 9007199254740992n, size: 42n })
  const second = auxiliaryFileIdentity({ dev: 1n, ino: 9007199254740993n, size: 42n })
  assert.notEqual(first.inode, second.inode)
  assert.equal(BigInt(JSON.parse(JSON.stringify(second)).inode), 9007199254740993n)
  const artifact = { ...second, path: join(tmpdir(), 'artifact.bin'), directory: false }
  assert.equal(validPublishedArtifact(artifact), true)
  assert.equal(validPublishedArtifact({ ...artifact, inode: 123 }), true)
  assert.equal(validPublishedArtifact({ ...artifact, inode: Number(second.inode) }), false)
  for (const inode of ['-1', '1.5', '01', '18446744073709551616']) {
    assert.equal(validPublishedArtifact({ ...artifact, inode }), false, inode)
  }
})
