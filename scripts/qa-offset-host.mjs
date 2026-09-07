// Production Host offset-storage QA; local fixtures only, never the user's library.
// Requires an already-built Host with v2 selection enabled; deliberately does not build.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-offset-host-'))
const downloads = join(root, 'downloads'), support = join(root, 'engine')
mkdirSync(downloads); mkdirSync(support)
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
assert.ok(existsSync(hostBinary), 'Build the selected Host before running this script')
const payload = Buffer.alloc(64 * 1024 * 1024)
for (let i = 0; i < payload.length; i++) payload[i] = i % 251
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const expectedHash = hash(payload), etag = `"${expectedHash}"`
const ranges = [], measurements = []
let phase = 'initial', host, hostDone, hostError = '', taskID, work, active = 0, peakActive = 0
let sampler, peakAllocatedBytes = 0, sequence = 1
const server = httpServer((request, response) => {
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : payload.length - 1
  if (start < 0 || end >= payload.length || end < start) { response.writeHead(416); response.end(); return }
  response.writeHead(match ? 206 : 200, {
    'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes', ETag: etag,
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') { response.end(); return }
  if (match) ranges.push({ phase, start, end })
  active++; peakActive = Math.max(peakActive, active)
  let offset = start, timer
  response.on('close', () => { active--; clearTimeout(timer) })
  const send = () => {
    if (response.destroyed) return
    const next = Math.min(end + 1, offset + 16384)
    response.write(payload.subarray(offset, next)); offset = next
    if (offset > end) { response.end(); return }
    timer = setTimeout(send, phase === 'restarted' ? 2 : 80)
  }
  send()
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
async function freePort() {
  const socket = createServer()
  await new Promise(done => socket.listen(0, '127.0.0.1', done))
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  return port
}
const hostPort = await freePort()
let bridgePort = await freePort()
while (bridgePort === hostPort) bridgePort = await freePort()
function rpc(op, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = sequence++, socket = createConnection({ host: '127.0.0.1', port: hostPort })
    let buffer = ''
    socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy(new Error('Host RPC timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let item
        try { item = JSON.parse(line) } catch (error) { socket.destroy(error); return }
        if (item.id === id) { socket.end(); item.ok ? resolve(item) : reject(new Error(JSON.stringify(item))); return }
      }
    })
  })
}
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}
async function launch() {
  host = spawn(hostBinary, [], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: tmpdir(),
    NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  hostDone = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', error => resolve({ error: error.message })) })
  host.stderr.on('data', chunk => { hostError = (hostError + chunk).slice(-8000) })
  await until(async () => {
    if (host.exitCode !== null || host.signalCode !== null) throw new Error('Host exited: ' + hostError)
    return rpc('ping').catch(() => false)
  }, 'isolated Host ready', 10000)
}
function files(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name)
    if (entry.isDirectory()) return files(file)
    if (!entry.isFile()) return []
    try { const stat = statSync(file); return [{ path: relative(root, file), logicalBytes: stat.size, allocatedBytes: stat.blocks * 512 }] }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  })
}
function inventory() { return [...files(downloads), ...(work ? files(work) : [])] }
function measure(label) {
  const entries = inventory(), allocatedBytes = entries.reduce((sum, file) => sum + file.allocatedBytes, 0)
  peakAllocatedBytes = Math.max(peakAllocatedBytes, allocatedBytes)
  assert.equal(entries.filter(file => /\/seg\.x\d+$/.test(file.path) && file.logicalBytes > 0).length, 0, 'v2 must never accumulate legacy segment payloads')
  const sample = { label, allocatedBytes, ratioToPayload: allocatedBytes / payload.length, files: entries }
  measurements.push(sample)
  return sample
}
function manifest() { return JSON.parse(readFileSync(join(work, 'offset-storage-v2.json'), 'utf8')) }
function partialState() {
  const state = manifest(), path = join(downloads, state.partialName)
  return { prefix: state.ranges.reduce((sum, range) => sum + range.durablePrefix, 0), hash: hash(readFileSync(path)), path }
}
try {
  await launch()
  const added = await rpc('add', { url: `http://127.0.0.1:${server.address().port}/offset.bin`, folderPath: downloads, connections: 32 })
  taskID = added.task.id; work = join(support, String(taskID))
  sampler = setInterval(() => {
    const allocated = inventory().reduce((sum, file) => sum + file.allocatedBytes, 0)
    peakAllocatedBytes = Math.max(peakAllocatedBytes, allocated)
  }, 100)
  await until(() => new Set(ranges.filter(r => r.phase === 'initial' && r.end - r.start > 128 * 1024).map(r => r.start)).size >= 32, '32 initial Range attempts')
  await delay(150)
  await rpc('pause', { taskID })
  assert.ok(existsSync(join(work, 'offset-storage-v2.json')), 'Host must select production v2; legacy execution is not a passing result')
  measure('paused')
  const paused = partialState()
  assert.ok(paused.prefix > 0 && paused.prefix < payload.length, 'Pause must checkpoint a real partial download')
  await delay(250)
  assert.deepEqual(partialState(), paused, 'No writer may change the owned file after pause returns')
  phase = 'resumed'
  await rpc('resume', { taskID })
  await until(() => ranges.some(r => r.phase === 'resumed'), 'resume request')
  await delay(160)
  measure('before-kill')
  host.kill('SIGKILL')
  assert.equal((await hostDone).signal, 'SIGKILL')
  measure('after-kill')
  phase = 'restarted'
  await launch()
  await rpc('resume', { taskID })
  const completed = await until(async () => {
    const task = (await rpc('list')).tasks.find(task => task.id === taskID)
    assert.notEqual(task?.status, 'error', task?.errorText)
    return task?.status === 'complete' && task
  }, 'completion after killed Host restarts', 45000)
  const finalPath = join(completed.folderPath, completed.filename)
  assert.equal(hash(readFileSync(finalPath)), expectedHash, 'Independent final SHA-256 must match server payload')
  assert.equal(readdirSync(downloads).filter(name => name.startsWith('.ndm-offset-') && name.endsWith('.partial')).length, 0, 'Publication must leave no owned partial')
  assert.ok(ranges.some(r => r.phase === 'resumed' && r.start % (payload.length / 32) !== 0), 'Resume should retain a written prefix')
  const final = measure('complete')
  assert.equal(final.files.filter(file => file.path.startsWith('downloads/')).length, 1, 'Only one payload file remains')
  const report = { passed: true, root, hostBinary, hostSHA256: hash(readFileSync(hostBinary)), payloadBytes: payload.length,
    sha256: expectedHash, taskID, initialRangeAttempts: ranges.filter(r => r.phase === 'initial').length, peakActiveRequests: peakActive,
    pausedDurableBytes: paused.prefix, pauseResume: true, killedHostResume: true, peakAllocatedBytes,
    peakAllocationRatio: peakAllocatedBytes / payload.length, measurements, ranges }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ passed: false, error: String(error), root, hostBinary, hostError, measurements, ranges }, null, 2) + '\n')
  throw error
} finally {
  clearInterval(sampler)
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM')
    const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await hostDone; clearTimeout(timer)
  }
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
