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
import { WindowsAuxiliaryTransfer, safeAuxiliaryPath } from '../src/main/windows/auxiliaryTransfer.ts'
import { WindowsAuxiliaryDaemon } from '../src/main/windows/auxiliaryDaemon.ts'
import { WindowsAuxiliaryRPCError } from '../src/main/windows/auxiliaryRpc.ts'

const pin = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`
const source = { kind: 'magnet', url: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function fakeDaemon() {
  const rows = new Map(), calls = []
  let loseAdd = false
  const daemon = {
    rows, calls, set loseAdd(value) { loseAdd = value },
    start: async () => ({ bittorrent: true, ed2k: true, sftp: true, fileSelection: true, stopSeeding: true }),
    stop: async () => {}, rpc: async () => ({ call: async (op, args = []) => {
      calls.push({ op, args: structuredClone(args) })
      if (op === 'aria2.addUri' || op === 'aria2.addTorrent') {
        const options = args[op === 'aria2.addUri' ? 1 : 2]
        const journal = JSON.parse(await readFile(join(options.dir, '..', 'transfer.json'), 'utf8'))
        assert.equal(journal.gid, options.gid, 'GID is durable before first RPC')
        assert.equal(rows.has(options.gid), false, 'fixed GID must not be blindly added twice')
        rows.set(options.gid, { gid: options.gid, status: 'paused', totalLength: '4', completedLength: '0', downloadSpeed: '0', uploadSpeed: '0',
          ...(options['pause-metadata'] ? { bittorrent: { state: 'paused', info: { name: 'fixture.bin' } } } : {}),
          files: [{ index: '1', path: join(options.dir, 'fixture.bin'), length: '4', completedLength: '0', selected: 'true' }] })
        if (loseAdd) { loseAdd = false; throw new WindowsAuxiliaryRPCError('unavailable') }
        return options.gid
      }
      const row = rows.get(args[0])
      if (!row) throw new WindowsAuxiliaryRPCError('notFound')
      if (op === 'aria2.tellStatus') return structuredClone(row)
      if (op === 'aria2.unpause') { row.status = 'active'; return row.gid }
      if (op === 'aria2.forcePause') { row.status = 'paused'; if (row.bittorrent) row.bittorrent.state = 'paused'; return row.gid }
      if (op === 'aria2.forceRemove' || op === 'aria2.removeDownloadResult') { rows.delete(row.gid); return row.gid }
      if (op === 'aria2.changeOption') { if (args[1]['select-file']) for (const file of row.files) file.selected = args[1]['select-file'].split(',').includes(file.index) ? 'true' : 'false'; return 'OK' }
      assert.fail(`unexpected RPC ${op}`)
    } })
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
  const f = await fixture(t), added = await create(f.engine, { source: { kind: 'ed2k', url: `ed2k://|file|fixture.bin|4|${'b'.repeat(32)}|sources,127.0.0.1:4662|/` }, autoStart: true })
  const row = [...f.daemon.rows.values()][0]
  await writeFile(row.files[0].path, 'data'); row.completedLength = '4'; row.files[0].completedLength = '4'; row.seeder = 'true'
  assert.equal((await f.engine.request('auxiliaryStatus', { taskID: added.taskID })).snapshot.phase, 'seeding')
  await f.engine.request('auxiliaryStopSeeding', { taskID: added.taskID, generation: 1 })
  const task = (await f.engine.request('list')).tasks[0]
  assert.equal(task.status, 'complete'); assert.equal(await readFile(join(task.folderPath, task.filename), 'utf8'), 'data')
})
