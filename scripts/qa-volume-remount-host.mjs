// Isolated volume remount characterization; two disposable disk images only.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, statfs, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw Error('This fixture requires macOS hdiutil')
if (!process.argv[2]) throw Error('Pass an isolated NDMHost binary')
const filesystem = process.argv.includes('--exfat') ? 'ExFAT' : 'APFS'
const binary = resolve(process.argv[2]), root = await mkdtemp(join(tmpdir(), 'ndm-remount-'))
const mount = join(root, 'volume'), home = join(root, 'home'), support = join(root, 'support')
const downloads = join(mount, 'downloads'), decoyMount = join(root, 'decoy')
for (const path of [mount, home, support, decoyMount]) await mkdir(path)
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
let attached = false, decoyAttached = false, host, exited, sequence = 0
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
  await until('Partial transfer before remount', async () => {
    const row = await task()
    if (row.status === 'error') {
    const metadata = JSON.parse(await readFile(join(support, String(row.id), 'offset-storage-v2.json'), 'utf8'))
    assert.equal(metadata.parentPath, downloads)
    const diskFile = await stat(join(downloads, metadata.partialName)), diskParent = await stat(downloads)
    console.log(JSON.stringify({ filesystem, expectedFile: metadata.file, actualFile: { dev: diskFile.dev, ino: diskFile.ino, birthtimeMs: diskFile.birthtimeMs, size: diskFile.size }, expectedParent: metadata.parent, actualParent: { dev: diskParent.dev, ino: diskParent.ino, birthtimeMs: diskParent.birthtimeMs } }))
    throw Error(JSON.stringify({ stage: 'initial-transfer', filesystem, errorText: row.errorText, diagnostic: row.diagnostic }))
    }
    return row.status === 'downloading' && row.completedBytes >= 262144
  })
  assert.equal((await rpc('pause', { taskID: created.task.id })).ok, true)
  const receiptPath = join(support, String(created.task.id), 'offset-storage-v2.json')
  const receiptText = await readFile(receiptPath, 'utf8'), receipt = JSON.parse(receiptText)
  const partial = join(receipt.parentPath, receipt.partialName)
  const before = await stat(partial), digest = hash(await readFile(partial))
  const prefix = receipt.ranges.reduce((sum, range) => sum + range.durablePrefix, 0)
  assert.ok(prefix > 0)
  host.kill('SIGTERM'); await exited
  execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 30000 }); attached = false
  // Occupy the prior device slot to model reconnecting drives in a new order.
  execFileSync('/usr/bin/hdiutil', ['create', '-size', '128m', '-fs', 'APFS', '-volname', 'NDM Decoy QA', join(root, 'decoy.dmg')], { stdio: 'pipe', timeout: 30000 })
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', decoyMount, join(root, 'decoy.dmg')], { stdio: 'pipe', timeout: 30000 }); decoyAttached = true
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, join(root, 'fixture.dmg')], { stdio: 'pipe', timeout: 30000 }); attached = true
  const after = await stat(partial)
  assert.notEqual(after.dev, before.dev, 'Fixture must actually change the transient device number')
  assert.equal(after.ino, before.ino); assert.equal(after.birthtimeMs, before.birthtimeMs)
  assert.equal(hash(await readFile(partial)), digest)
  host = spawn(binary, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  exited = once(host, 'exit')
  await until('Restarted Host ready', async () => (await rpc('ping').catch(() => null))?.ok)
  assert.equal((await task()).status, 'paused')
  const beforeResume = ranges.length
  const resumed = await rpc('resume', { taskID: created.task.id })
  assert.equal(resumed.ok, true)
  const terminal = await until('Remounted task terminal', async () => { const row = await task(); return ['error','complete'].includes(row.status) && row })
  console.log(JSON.stringify({ filesystem, resumed, beforeDevice: before.dev, afterDevice: after.dev, sameInode: before.ino === after.ino, sameBirth: before.birthtimeMs === after.birthtimeMs, status: terminal.status, diagnostic: terminal.diagnostic, errorText: terminal.errorText, prefix }))
  if (terminal.status === 'complete') {
    assert.equal(hash(await readFile(join(terminal.folderPath, terminal.filename))), hash(payload))
    assert.ok(ranges.slice(beforeResume).some(row => row.method === 'GET' && row.end > row.start && row.start === prefix))
    assert.equal((await rpc('list')).tasks.length, 1)
    console.log(JSON.stringify({ passed: true, sameTaskResumed: true, durablePrefix: prefix, finalSHA256: hash(payload), hostSHA256: hash(await readFile(binary)) }))
  } else { assert.equal(hash(await readFile(partial)), digest); assert.equal(await readFile(receiptPath, 'utf8'), receiptText) }
  if (!process.argv.includes('--capture-baseline')) assert.equal(terminal.status, 'complete', 'Same disk after remount must resume')

} finally {
  if (host && host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await exited }
  server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
  if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 30000 })
  if (decoyAttached) execFileSync('/usr/bin/hdiutil', ['detach', decoyMount], { stdio: 'pipe', timeout: 30000 })
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, disposableVolumeDetached: attached }))
}
