// Real isolated Host retries: mid-body disconnections and exhausted startup refusals.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-network-recovery-'))
const support = join(root, 'support'), downloads = join(root, 'downloads'), home = join(root, 'home')
await mkdir(support); await mkdir(downloads); await mkdir(home)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 1200; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payload = randomBytes(2 * 1024 * 1024)
const attempts = []
let disconnects = 0, refusals = 0
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  if (req.method !== 'HEAD' && req.url === '/refused.bin') {
    refusals++; res.writeHead(503, { 'Retry-After': '0', 'Content-Length': 0 }); res.end(); return
  }
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"network-recovery-fixture"',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (req.method === 'HEAD') { res.end(); return }
  attempts.push({ start, end })
  if (disconnects < 4) {
    disconnects++
    res.write(payload.subarray(start, Math.min(start + 65536, end + 1)))
    const timer = setTimeout(() => res.destroy(), 30)
    res.on('close', () => clearTimeout(timer))
  } else res.end(payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const host = spawn(binary, [], { env: { ...process.env, HOME: home, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
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
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  const created = await request('add', { url: `${base}/flaky.bin`, filename: 'flaky.bin', folderPath: downloads, connections: 1, autoStart: true })
  assert.equal(created.ok, true)
  const complete = await until('interrupted download complete', async () => (await request('list')).tasks.find(task => task.id === created.task.id && task.status === 'complete'))
  const actual = await readFile(join(downloads, complete.filename))
  assert.deepEqual(actual, payload)
  assert.equal(disconnects, 4)
  assert.ok(attempts.length >= 5)
  assert.ok(attempts.slice(1).every(row => row.start > 0), 'Retries must retain actual transferred bytes')
  assert.ok(attempts.slice(1).every((row, index) => row.start > attempts[index].start), 'Each interrupted attempt must advance the next range')
  const refused = await request('add', { url: `${base}/refused.bin`, filename: 'refused.bin', folderPath: downloads, connections: 1, autoStart: true })
  assert.equal(refused.ok, true)
  const failed = await until('startup refusal stops', async () => (await request('list')).tasks.find(task => task.id === refused.task.id && task.status === 'error'))
  assert.equal(refusals, 4, 'Startup refusal has only three automatic retries')
  assert.equal(failed.diagnostic.primaryAction, 'retry')
  assert.equal(failed.completedBytes, 0)
  await delay(500)
  assert.equal(refusals, 4, 'No further requests after retry budget is exhausted')
  console.log(JSON.stringify({ passed: true, disconnects, rangeStarts: attempts.map(row => row.start),
    actualBytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex'),
    startupRefusals: refusals, exhaustedAction: failed.diagnostic.primaryAction, tasks: (await request('list')).tasks.length }))
} finally {
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, hostStopped: host.exitCode !== null || host.signalCode !== null }))
}
