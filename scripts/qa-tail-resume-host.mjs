// Persisted speculative-tail rollback after SIGKILL: real Host, 4 initial connections, local HTTP only.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-tail-resume-host-'))
const downloads = join(root, 'downloads')
mkdirSync(downloads)
const home = join(root, 'home'); mkdirSync(home)
const payload = randomBytes(8 * 1024 * 1024)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const etag = '"' + digest(payload) + '"'
const segmentBytes = payload.length / 4
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
let phase = 0, childRequest, host, childRequestAt, rejectedChildren = 0, hostDone
const ranges = []
const server = httpServer((request, response) => {
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : 0
  const end = match ? Number(match[2]) : payload.length - 1
  if (phase === 1 && match && childRequest && start >= childRequest.start && start <= childRequest.end && end === childRequest.end) {
    rejectedChildren++
    response.writeHead(416, { 'Content-Range': `bytes */${payload.length}`, ETag: etag }); response.end(); return
  }
  response.writeHead(match ? 206 : 200, {
    'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes', ETag: etag,
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') { response.end(); return }
  ranges.push({ phase, start, end })
  if (phase === 0 && match && start % segmentBytes !== 0 && !childRequest) {
    childRequest = { start, end }
    childRequestAt = Date.now()
    host?.kill('SIGKILL')
  }
  let offset = start, timer
  const send = () => {
    if (response.destroyed) return
    const next = Math.min(end + 1, offset + 32768)
    response.write(payload.subarray(offset, next)); offset = next
    if (offset > end) { response.end(); return }
    timer = setTimeout(send, phase === 1 ? 1 : start === 0 ? 2 : 15)
  }
  response.on('close', () => clearTimeout(timer))
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
let sequence = 1, hostError = ''
function request(op, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = sequence++, socket = createConnection({ host: '127.0.0.1', port: hostPort })
    let buffer = ''
    socket.setEncoding('utf8'); socket.setTimeout(3000, () => socket.destroy(new Error('request timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), item = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (item.id === id) { socket.end(); item.ok ? resolve(item) : reject(new Error(JSON.stringify(item))); return }
      }
    })
  })
}
async function launch() {
  host = spawn(hostBinary, [], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root, LANG: 'en_US.UTF-8',
    NDM_SUPPORT_DIR: join(root, 'engine'), NDM_HOST_PORT: String(hostPort),
    NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  hostDone = new Promise(done => { host.once('exit', done); host.once('error', done) })
  host.stderr.on('data', chunk => { hostError = (hostError + chunk).slice(-4000) })
  host.on('error', error => { hostError = error.message })
  for (let i = 0; i < 60; i++) {
    if (await request('ping').catch(() => false)) return
    if (host.exitCode !== null) throw new Error('Host exited: ' + hostError)
    await delay(100)
  }
  throw new Error('Host did not start: ' + hostError)
}
try {
  await launch()
  const added = await request('add', { url: `http://127.0.0.1:${server.address().port}/crash.bin`,
    folderPath: downloads, connections: 4 })
  for (let i = 0; i < 200 && !childRequest; i++) await delay(25)
  assert.ok(childRequest, 'Must observe a real automatic child request before killing the host')
  for (let i = 0; i < 100 && host.signalCode === null; i++) await delay(20)
  assert.equal(host.signalCode, 'SIGKILL')
  const work = join(root, 'engine', String(added.task.id))
  assert.ok(existsSync(join(work, 'offset-storage-v2.json')), 'Strong-validator fresh task uses v2')
  const journal = JSON.parse(readFileSync(join(work, 'tail-split-provenance.json'), 'utf8'))
  const origin = journal.candidate.origins.find(o => journal.candidate.plan.some(p => p.id === o.child && p.start === childRequest.start && p.end === childRequest.end))
  assert.ok(origin, 'Persisted journal must identify actual speculative child before restart')
  const persistedChild = journal.candidate.plan.find(record => record.id === origin.child)
  // Restart rejection is authorized by persisted geometry, never by guessed IDs.
  childRequest = { start: persistedChild.start, end: persistedChild.end }
  const parentStart = Math.floor(childRequest.start / segmentBytes) * segmentBytes
  assert.equal(ranges.filter(r => r.phase === 0 && r.start === parentStart).length, 1,
    'Live split must not restart the original parent request')
  phase = 1
  await launch()
  await request('resume', { taskID: added.task.id })
  let task
  for (let i = 0; i < 300; i++) {
    task = (await request('list')).tasks.find(item => item.id === added.task.id)
    if (task?.status === 'complete') break
    if (task?.status === 'error') throw new Error('Resume failed: ' + task.errorText)
    await delay(50)
  }
  assert.equal(task?.status, 'complete')
  assert.equal(digest(readFileSync(join(task.folderPath, task.filename))), digest(payload))
  assert.ok(ranges.some(r => r.phase === 1 && r.start > parentStart && r.start < childRequest.start),
    'Restart must preserve and resume the already written parent prefix')
  assert.ok(rejectedChildren > 0, 'Must reject persisted speculative child after restart')
  const log = readFileSync(join(work, 'LogFile.txt'), 'utf8')
  assert.ok(log.includes('Segment Rolled Back To Socket'), 'Actual engine must log rollback, not generic retry')
  const report = { passed: true, root, hostSHA256: digest(readFileSync(hostBinary)), initialConnections: 4,
    childRequest, parentStart, childRequestAt, rejectedChildren, journalOriginVerified: true, rollbackLogged: true,
    originalParentRequests: 1, resumedParentPrefix: true, finalBytes: payload.length, sha256: digest(payload) }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)+'\n'); console.log(JSON.stringify(report))
} finally {
  if (host && host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); const timer = setTimeout(()=>host.kill('SIGKILL'),2000); await hostDone; clearTimeout(timer) }
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  // Only this mkdtemp fixture's generated payload, database and preferences.
  for (const directory of [downloads, join(root, 'engine'), home]) rmSync(directory, {recursive:true,force:true})
}
