// Real isolated Host + two independent Relay worker connections + local payload.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const uiMode = process.argv.includes('--ui')
let ui
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-recovery-host-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(512 * 1024, 0x73), received = []
const server = createServer((req, res) => {
  received.push({ path: req.url, cookie: req.headers.cookie, referer: req.headers.referer, userAgent: req.headers['user-agent'] })
  if (req.url === '/expired.bin') { res.writeHead(403); res.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"page-media-fixture"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const mediaURL = `http://127.0.0.1:${server.address().port}/selected.mp4`
const host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
const exited = once(host, 'exit')
let seq = 0
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = ++seq, socket = createConnection({ host: '127.0.0.1', port: hostPort })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Host ${op} timeout`)) }, 12000)
  let buffer = ''
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ ...extra, op, id }) + '\n'))
  socket.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    let reply; try { reply = JSON.parse(line) } catch { continue }
    if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolve(reply); return }
  } })
})
const page = 'https://www.douyin.com/jingxuan?modal_id=123456789', mediaKey = 'frame-0123456789abcdef', sourceID = randomUUID()
const workers = [], preparedBy = [], errors = []
const connect = async label => {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, ['ndm.open.v1'])
  const hello = new Promise(resolve => socket.addEventListener('message', event => { if (String(event.data).startsWith('NDMRelayStatus:')) resolve() }))
  socket.addEventListener('message', event => {
    const prefix = 'NDMRelayPageMediaRequest:', value = String(event.data)
    if (!value.startsWith(prefix)) return
    try {
      const query = JSON.parse(value.slice(prefix.length))
      if (query.op === 'discover') socket.send('NDMRelayPageMediaResponse:' + JSON.stringify({ requestId: query.requestId, op: 'discover', sources: [{ sourceID, pageURL: page, title: label, browser: 'chrome', incognito: false, tabId: 1, documentID: randomUUID(), items: [{ mediaKey, title: '1080p', meta: 'MP4', badge: '', kind: 'video', quality: '1080' }] }] }))
      else {
        preparedBy.push(label)
        assert.equal(query.sourceID, sourceID); assert.equal(query.mediaKey, mediaKey); assert.equal(query.pageURL, page)
        socket.send('NDMRelayPageMediaResponse:' + JSON.stringify({ requestId: query.requestId, op: 'prepare', sourceID, mediaKey, pageURL: page,
          payload: `1:GET\r\n2:${mediaURL}\r\n3:captured.mp4\r\n4:${label}\r\n5:${page}\r\n6:media\r\n9:fixture-browser\r\nReferer: ${page}\r\nCookie: selected=${label}\r\n14:unneeded-page-jar` }))
      }
    } catch (error) { errors.push(error) }
  })
  await once(socket, 'open'); socket.send('NDMRelayHello:' + JSON.stringify({ version: '1.4.16', protocol: 1, role: 'worker', pageMedia: 1, browser: 'chrome' })); await hello
  workers.push(socket)
}
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  const legacy = await request('probeBrowserPageMedia', { pageURL: page })
  assert.equal(legacy.ok, false); assert.match(legacy.error, /更新 NDM Relay/)
  await connect('profile-a'); await connect('profile-b')
  const probe = await request('probeBrowserPageMedia', { pageURL: page })
  assert.equal(probe.ok, true); assert.equal(probe.sources.length, 2)
  assert.notEqual(probe.sources[0].sourceToken, probe.sources[1].sourceToken)
  assert.equal(received.length, 0); assert.equal((await request('list')).tasks.length, 0)
  assert.doesNotMatch(JSON.stringify(probe), /selected=|unneeded-page-jar|127\.0\.0\.1|selected\.mp4/)
  const selected = probe.sources.find(source => source.title === 'profile-b')
  const intent = { pageURL: page, sourceToken: selected.sourceToken, mediaKey, creationKey: randomUUID(), connections: 4, folderPath: downloads, filename: 'reviewed.mp4' }
  const invalid = await request('addBrowserPageMedia', { ...intent, creationKey: randomUUID(), pageURL: page + '0' })
  assert.equal(invalid.ok, false); assert.equal(preparedBy.length, 0)
  const [created, concurrent] = await Promise.all([request('addBrowserPageMedia', intent), request('addBrowserPageMedia', intent)])
  assert.equal(created.ok, true); assert.equal(concurrent.task.id, created.task.id)
  assert.deepEqual(preparedBy, ['profile-b'])
  const complete = await until('artifact complete', async () => (await request('list')).tasks.find(task => task.id === created.task.id && task.status === 'complete'))
  const explicitFilenamePreserved = complete.filename === 'reviewed.mp4'
  if (!process.argv.includes('--allow-legacy-filename')) assert.equal(complete.filename, 'reviewed.mp4')
  assert.equal(complete.folderPath, downloads); assert.equal(complete.pageURL, page)
  assert.deepEqual(await readFile(join(downloads, complete.filename)), payload)
  assert.ok(received.length > 0 && received.every(row => row.cookie === 'selected=profile-b' && row.referer === page && row.userAgent === 'fixture-browser'))
  // A real failed task with retained segment data recovers through the selected
  // Relay worker. Its URL and credentials are never typed into the renderer.
  const expiredURL = mediaURL.replace('/selected.mp4', '/expired.bin')
  const added = await request('add', { url: expiredURL, pageURL: page, filename: 'recovered.mp4', folderPath: downloads, autoStart: true })
  assert.equal(added.ok, true)
  const expired = await until('expired task', async () => (await request('list')).tasks.find(task => task.url === expiredURL && task.status === 'error'))
  const oldWork = join(support, String(expired.id))
  await mkdir(oldWork, { recursive: true })
  const retained = Buffer.from('previous incomplete bytes - never concatenate')
  await writeFile(join(oldWork, 'seg.x99'), retained)
  // A browser restart must retire connection-bound choices. Even when another
  // profile exposes the same sourceID, an old selection cannot switch accounts.
  const beforeRestart = await request('probeBrowserPageMedia', { pageURL: page })
  const priorSource = beforeRestart.sources.find(item => item.title === 'profile-b')
  const closed = once(workers[1], 'close')
  workers[1].close(); await closed
  await connect('profile-b')
  const preparedBeforeStaleChoice = preparedBy.length
  const staleChoice = await request('recoverBrowserPageMedia', {
    taskID: expired.id, expectedURL: expired.url, expectedGeneration: 0,
    pageURL: page, sourceToken: priorSource.sourceToken, mediaKey, redownload: true
  })
  assert.equal(staleChoice.ok, false, 'Reconnected browser must require a fresh choice')
  assert.equal(preparedBy.length, preparedBeforeStaleChoice, 'Do not prepare in a different profile')
  assert.equal((await request('list')).tasks.find(task => task.id === expired.id).url, expiredURL)
  assert.deepEqual(await readFile(join(oldWork, 'seg.x99')), retained)
  const fresh = await request('probeBrowserPageMedia', { pageURL: page })
  const source = fresh.sources.find(item => item.title === 'profile-b')
  assert.notEqual(source.sourceToken, priorSource.sourceToken)
  const recovery = { taskID: expired.id, expectedURL: expired.url, expectedGeneration: 0, pageURL: page, sourceToken: source.sourceToken, mediaKey }
  const preview = await request('recoverBrowserPageMedia', recovery)
  assert.equal(preview.ok, true); assert.equal(preview.result, 'needsRedownload')
  assert.equal((await request('list')).tasks.find(task => task.id === expired.id).url, expiredURL)
  assert.deepEqual(await readFile(join(oldWork, 'seg.x99')), retained)
  let delivered
  if (uiMode) {
    const appBinary = process.env.NDM_QA_APP_BINARY || 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    const appArguments = [...(process.env.NDM_QA_APP_BINARY ? [] : ['.']), `--user-data-dir=${join(root, 'electron')}`]
    ui = spawn(appBinary, appArguments, {
      env: { ...process.env, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_SUPPORT_DIR: support, NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore'
    })
    console.log(JSON.stringify({ uiReady: true, hostPort, bridgePort, root, taskID: expired.id }))
    for (let n = 0; n < 1200; n++) {
      delivered = (await request('list')).tasks.find(task => task.id === expired.id && task.status === 'complete')
      if (delivered) break
      await delay(500)
    }
    assert.ok(delivered, 'UI must complete recovery within ten minutes')
  } else {
    const recovered = await request('recoverBrowserPageMedia', { ...recovery, redownload: true })
    assert.equal(recovered.ok, true); assert.equal(recovered.result, 'started')
    delivered = await until('recovered artifact', async () => (await request('list')).tasks.find(task => task.id === expired.id && task.status === 'complete'))
  }
  assert.equal(delivered.filename, 'recovered.mp4'); assert.equal(delivered.folderPath, downloads)
  assert.deepEqual(await readFile(join(downloads, delivered.filename)), payload)
  assert.deepEqual(await readFile(join(oldWork, 'seg.x99')), retained)
  assert.equal(delivered.recoveryGeneration, 1)
  const stale = await request('recoverBrowserPageMedia', { ...recovery, redownload: true })
  assert.equal(stale.ok, false)
  assert.equal((await request('list')).tasks.length, 2)
  assert.ok(preparedBy.every(profile => profile === 'profile-b'))
  assert.ok(received.filter(row => row.path === '/selected.mp4').every(row =>
    row.cookie === 'selected=profile-b' && row.referer === page && row.userAgent === 'fixture-browser'))
  console.log(JSON.stringify({ recovery: true, sameTask: true, oldBytesPreserved: true, staleRequestRejected: true,
    browserReconnectRequiresFreshChoice: true, noCrossProfileFallback: true, exactArtifact: true }))
  for (const socket of workers) socket.close()
  await delay(100)
  const replay = await request('addBrowserPageMedia', intent)
  assert.equal(replay.task.id, created.task.id); assert.equal((await request('list')).tasks.length, 2)
  const mismatch = await request('addBrowserPageMedia', { ...intent, filename: 'changed.mp4' })
  assert.equal(mismatch.errorKind, 'creationIntentMismatch')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, isolatedSources: 2, discoveryTransfers: 0, selectedProfileOnly: true, actualBytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'), explicitFilenamePreserved, headersAndPagePreserved: true, concurrentAndDisconnectedReplaySameTask: true, tasks: 2 }))
  if (uiMode) { console.log('UI_VERIFIED'); await delay(30000) }
} finally {
  if (ui && ui.exitCode === null && ui.signalCode === null) { const uiExited = once(ui, 'exit'); ui.kill('SIGTERM'); await uiExited }
  for (const socket of workers) socket.close()
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, hostStopped: host.exitCode !== null || host.signalCode !== null, supportRemoved: true, localServerClosed: true }))
}
