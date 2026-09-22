// Incompatible-destination recovery using one disposable ExFAT disk image.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, statfs, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw Error('This fixture requires macOS hdiutil')
if (!process.argv[2]) throw Error('Pass an isolated NDMHost binary')
const filesystem = 'ExFAT'
const binary = resolve(process.argv[2]), root = await mkdtemp(join(tmpdir(), 'ndm-destination-capability-'))
const mount = join(root, 'volume'), home = join(root, 'home'), support = join(root, 'support')
const downloads = join(mount, 'downloads')
for (const path of [mount, home, support]) await mkdir(path)
const delay = ms => new Promise(done => setTimeout(done, ms))
async function until(label, predicate, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
async function freePort() { const server = tcpServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port }
const port = await freePort(), bridge = await freePort()
const payload = randomBytes(8 * 1024 * 1024), hash = data => createHash('sha256').update(data).digest('hex')
const etag = `"${hash(payload)}"`, ranges = []
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1
  ranges.push({ method: req.method, start, end })
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: etag, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (req.method === 'HEAD') { res.end(); return }
  let offset = start, timer
  res.on('close', () => clearTimeout(timer))
  const send = () => {
    if (res.destroyed) return
    const next = Math.min(end + 1, offset + 65536)
    res.write(payload.subarray(offset, next)); offset = next
    if (offset > end) res.end(); else timer = setTimeout(send, 10)
  }
  send()
})
let attached = false, host, exited, rendererFixture, sequence = 0
function rpc(op, extra = {}) {
  return new Promise((done, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port })
    let buffer = '', settled = false
    const finish = (error, reply) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : done(reply) }
    socket.setTimeout(5000, () => finish(Error(`RPC ${op} timeout`)))
    socket.on('error', error => finish(error)); socket.on('close', () => finish(Error('RPC closed')))
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...extra }) + '\n'))
    socket.on('data', chunk => { buffer += chunk; for (let i; (i = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const reply = JSON.parse(line); if (reply.id === id) finish(null, reply) } catch { finish(Error('Malformed RPC')) } } })
  })
}
try {
  execFileSync('/usr/bin/hdiutil', ['create', '-size', '128m', '-fs', filesystem, '-volname', 'NDM Disk QA', join(root, 'fixture.dmg')], { stdio: 'pipe', timeout: 30000 })
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, join(root, 'fixture.dmg')], { stdio: 'pipe', timeout: 30000 }); attached = true
  await mkdir(downloads)
  const capacity = await statfs(mount)
  assert.ok(capacity.blocks * capacity.bsize < 160 * 1024 * 1024, 'Only use the small disposable volume')
  assert.notEqual((await stat(root)).dev, (await stat(mount)).dev, 'Disk image must be a separate mounted filesystem')
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  host = spawn(binary, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  exited = once(host, 'exit')
  await until('Host ready', async () => (await rpc('ping').catch(() => null))?.ok)
  const created = await rpc('add', { url: `http://127.0.0.1:${server.address().port}/disk-test.bin`, folderPath: downloads, filename: 'disk-test.bin', connections: 1 })
  assert.equal(created.ok, true)
  const task = async () => (await rpc('list')).tasks.find(row => row.id === created.task.id)
  const waiting = await until('Unsupported destination prompts before transfer', async () => { const row = await task(); return row.awaitingDestination && row })
  assert.equal(waiting.status, 'paused')
  assert.equal(waiting.errorText, '#diag:unsupportedDestination')
  assert.equal(ranges.length, 0, 'No network request before compatible destination is chosen')
  assert.deepEqual(await readdir(downloads), [], 'No payload is created on the incompatible volume')
  const denied = await rpc('confirmDestination', { taskID: created.task.id, folderPath: downloads })
  assert.equal(denied.ok, false); assert.equal(denied.errorKind, 'unsupportedDestination')
  assert.equal((await task()).awaitingDestination, true)
  assert.equal(ranges.length, 0)
  host.kill('SIGTERM'); await exited
  host = spawn(binary, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  exited = once(host, 'exit')
  await until('Restarted Host ready', async () => (await rpc('ping').catch(() => null))?.ok)
  assert.equal((await task()).awaitingDestination, true)
  assert.equal((await task()).errorText, '#diag:unsupportedDestination')
  const compatible = join(root, 'compatible'); await mkdir(compatible)
  // An unrelated file on the rejected volume must remain untouched.
  const foreign = Buffer.from('unrelated user fixture'); await writeFile(join(downloads, 'unrelated.bin'), foreign)
  if (process.argv.includes('--browser-ui')) {
    const { startRendererHostFixture } = await import('./qa-renderer-host-fixture.mjs')
    rendererFixture = await startRendererHostFixture(rpc, { selectFolderPath: compatible })
    console.log(JSON.stringify({ uiReady: true, url: rendererFixture.url }))
  } else {
    const accepted = await rpc('confirmDestination', { taskID: created.task.id, folderPath: compatible })
    assert.equal(accepted.ok, true)
  }
  const complete = await until('Compatible destination completes original task', async () => { const row = await task(); return row.status === 'complete' && row }, rendererFixture ? 180000 : 30000)
  assert.equal(complete.id, created.task.id); assert.equal(complete.folderPath, compatible)
  assert.equal(complete.filename, 'disk-test.bin')
  assert.equal(hash(await readFile(join(compatible, complete.filename))), hash(payload))
  assert.deepEqual(await readFile(join(downloads, 'unrelated.bin')), foreign)
  assert.deepEqual(await readdir(downloads), ['unrelated.bin'])
  assert.equal((await rpc('list')).tasks.length, 1)
  console.log(JSON.stringify({ passed: true, filesystem, promptedBeforeNetwork: true, survivesRestart: true, rejectedConfirmationPreservesTask: true, sameTaskCompleted: true, finalSHA256: hash(payload) }))
  if (rendererFixture) await delay(15000)

} finally {
  if (rendererFixture) await rendererFixture.close()
  if (host && host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await exited }
  server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
  if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 30000 })
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, disposableVolumeDetached: attached }))
}
