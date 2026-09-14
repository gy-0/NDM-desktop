// Isolated real Host HTTP transfers; never reads the user's task store or cookies.
import assert from 'node:assert/strict'
import { createServer as createHTTPServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const payload = Buffer.alloc(3_413_896)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 251
const sha = data => createHash('sha256').update(data).digest('hex')
const etag = `"${sha(payload)}"`, requests = []
const root = mkdtempSync(join(tmpdir(), 'ndm-http-range-fallback-'))
const owned = join(root, 'owned'), support = join(owned, 'support'), downloads = join(owned, 'downloads'), home = join(owned, 'home')
for (const directory of [support, downloads, home]) mkdirSync(directory, { recursive: true })
const report = { passed: false, root, scope: 'Real isolated Host and local HTTP fixtures', cases: [] }
let host, exited, sequence = 0, activeRanges = 0, peakActiveRanges = 0
const server = createHTTPServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const record = { path, method: req.method, range: req.headers.range ?? null, status: null }
  requests.push(record)
  const respond = (status, headers, body) => {
    record.status = status; res.writeHead(status, { Connection: 'close', ...headers }); res.end(body)
  }
  if (path.startsWith('/redirect/')) {
    // localhost vs 127.0.0.1 exercises cross-origin redirect transport.
    respond(302, { Location: `http://localhost:${server.address().port}/head-416.bin`, 'Content-Length': 0 })
    return
  }
  if (req.method === 'HEAD') {
    if (path === '/probe-416.bin') respond(405, { 'Content-Length': 0 })
    else respond(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream', ETag: etag })
    return
  }
  if (path === '/forbidden.bin' || path === '/expired.bin') {
    respond(path === '/forbidden.bin' ? 403 : 410, { 'Content-Length': 0 }); return
  }
  if (match && path !== '/ranges.bin') {
    respond(416, { 'Content-Type': 'application/octet-stream', 'Content-Length': 0 }); return
  }
  const start = match ? Number(match[1]) : 0
  const end = match?.[2] ? Number(match[2]) : payload.length - 1
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: etag }
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${payload.length}`
  record.status = match ? 206 : 200
  if (match) {
    activeRanges++; peakActiveRanges = Math.max(peakActiveRanges, activeRanges)
    res.once('close', () => { activeRanges-- })
  }
  res.writeHead(record.status, headers)
  let offset = start, timer
  res.on('close', () => clearTimeout(timer))
  const send = () => {
    if (res.destroyed) return
    const next = Math.min(end + 1, offset + 32_768)
    res.write(payload.subarray(offset, next)); offset = next
    if (offset > end) res.end(); else timer = setTimeout(send, 3)
  }
  send()
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const baseURL = `http://127.0.0.1:${server.address().port}`
async function freePort() {
  const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done))
  const port = s.address().port; await new Promise(done => s.close(done)); return port
}
const port = await freePort(); let bridge = await freePort()
while (bridge === port) bridge = await freePort()
function rpc(op, fields = {}) {
  return new Promise((done, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port })
    let buffer = '', settled = false
    const finish = (error, value) => {
      if (settled) return; settled = true; socket.destroy(); error ? reject(error) : done(value)
    }
    socket.setEncoding('utf8'); socket.setTimeout(5000, () => finish(Error('RPC timeout')))
    socket.on('error', () => finish(Error('RPC connection failed')))
    socket.on('close', () => finish(Error('RPC closed')))
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        try { const value = JSON.parse(line); if (value.id === id) finish(null, value) }
        catch { finish(Error('Invalid RPC JSON')) }
      }
    })
  })
}
async function until(fn, label) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(50) }
  throw Error(label)
}
try {
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ baseURL, downloads, root, bytes: payload.length, sha256: sha(payload) }))
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done) })
  } else {
    const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/release/NDMHost')
    report.hostSHA256 = sha(readFileSync(hostPath))
    host = spawn(hostPath, [], { cwd: owned, stdio: 'ignore', env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: owned,
      LANG: 'en_US.UTF-8', NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port),
      NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1'
    } })
    exited = new Promise(done => { host.once('exit', done); host.once('error', done) })
    await until(async () => (await rpc('ping').catch(() => null))?.ok, 'Host not ready')
    assert.deepEqual((await rpc('list')).tasks, [])
    assert.equal((await rpc('updateSettings', { downloadDirectory: downloads, useCategoryFolders: false, maxConnections: 32 })).ok, true)
    const broken = process.argv.includes('--expect-broken')
    for (const path of ['/head-416.bin', '/probe-416.bin', '/redirect/file.bin', '/ranges.bin', '/forbidden.bin', '/expired.bin']) {
      const beginning = requests.length
      const added = await rpc('add', { url: baseURL + path, folderPath: downloads, connections: 32 })
      assert.equal(added.ok, true)
      const done = await until(async () => {
        const task = (await rpc('list')).tasks.find(t => t.id === added.task.id)
        return ['error', 'complete'].includes(task?.status) && task
      }, 'Transfer did not settle')
      const observed = requests.slice(beginning), gets = observed.filter(r => r.method === 'GET' && r.status !== 302)
      const expectedError = path === '/forbidden.bin' || path === '/expired.bin' || (broken && path !== '/ranges.bin')
      assert.equal(done.status, expectedError ? 'error' : 'complete', path)
      if (expectedError) {
        assert.equal(gets.length, 1, 'Permanent failures must not loop or retry without Range')
        const status = path === '/forbidden.bin' ? 403 : path === '/expired.bin' ? 410 : 416
        assert.equal(done.errorText, status === 416 ? '#diag:rangeNotSupported' : `#diag:linkExpired:${status}`)
      } else {
        assert.equal(sha(readFileSync(join(done.folderPath, done.filename))), sha(payload))
        assert.equal(done.completedBytes, payload.length)
        if (path === '/ranges.bin') {
          assert.ok(gets.length > 1, 'Normal server must keep parallel ranges')
          assert.ok(peakActiveRanges > 1, 'Range response bodies must overlap in time')
          assert.ok(gets.every(r => r.range && r.status === 206))
        } else {
          assert.equal(gets.filter(r => r.status === 416).length, 1)
          assert.equal(gets.filter(r => !r.range && r.status === 200).length, 1)
          assert.equal(gets.length, 2, 'One rejected Range and one successful clean GET')
        }
      }
      report.cases.push({ path, status: done.status, bytes: done.completedBytes, errorText: done.errorText, requests: observed,
        ...(path === '/ranges.bin' ? { peakActiveRanges } : {}),
        ...(done.status === 'complete' ? { sha256: sha(payload) } : {}) })
      assert.equal((await rpc('remove', { taskID: done.id, deleteFile: true })).ok, true)
    }
    assert.deepEqual((await rpc('list')).tasks, [])
    report.expectBroken = broken; report.passed = true
  }
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM')
    await Promise.race([exited, delay(5000).then(() => { throw Error('Host did not exit') })])
  }
  server.closeAllConnections(); await new Promise(done => server.close(done))
  rmSync(owned, { recursive: true, force: true })
  report.cleanedOwnedState = true
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
