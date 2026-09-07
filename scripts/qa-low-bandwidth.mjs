// Isolated low-bandwidth completion and pause check. Never uses the user's host, ports or library.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-low-bandwidth-'))
const downloads = join(root, 'downloads')
mkdirSync(downloads)
const payload = randomBytes(128 * 1024)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const etag = '"' + digest(payload) + '"'
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
let host
const server = httpServer((request, response) => {
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : 0
  const end = match ? Number(match[2]) : payload.length - 1
  response.writeHead(match ? 206 : 200, {
    'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes', ETag: etag,
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') { response.end(); return }
  let offset = start, timer
  const send = () => {
    if (response.destroyed) return
    const next = Math.min(end + 1, offset + 32768)
    response.write(payload.subarray(offset, next)); offset = next
    if (offset > end) { response.end(); return }
    timer = setTimeout(send, 1)
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
  host = spawn(hostBinary, [], { env: { ...process.env,
    NDM_SUPPORT_DIR: join(root, 'engine'), NDM_HOST_PORT: String(hostPort),
    NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
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
  const add = async filename => (await request('add', {
    url: `http://127.0.0.1:${server.address().port}/${filename}`,
    folderPath: downloads, connections: 1, autoStart: false
  })).task
  const waitComplete = async id => {
    for (let i = 0; i < 160; i++) {
      const task = (await request('list')).tasks.find(item => item.id === id)
      if (task?.status === 'complete') return task
      assert.notEqual(task?.status, 'error', task?.errorText)
      await delay(50)
    }
    throw new Error('Low-bandwidth transfer never completed')
  }
  const limited = await add('limited.bin')
  await request('setBandwidth', { taskID: limited.id, bandwidthLimit: 32768 })
  const start = performance.now()
  await request('resume', { taskID: limited.id })
  const complete = await waitComplete(limited.id)
  const elapsed = performance.now() - start
  assert.ok(elapsed >= 2500, `Limit was bypassed: ${elapsed} ms`)
  assert.equal(digest(readFileSync(join(complete.folderPath, complete.filename))), digest(payload))
  const paused = await add('paused.bin')
  await request('setBandwidth', { taskID: paused.id, bandwidthLimit: 1024 })
  await request('resume', { taskID: paused.id })
  await delay(300)
  const pauseStart = performance.now()
  await request('pause', { taskID: paused.id })
  const pauseMs = performance.now() - pauseStart
  assert.ok(pauseMs < 1500, `Pause did not drain promptly: ${pauseMs} ms`)
  const work = join(root, 'engine', String(paused.id))
  const snapshot = () => readdirSync(work).filter(name => /^seg\.x\d+$/.test(name)).map(name => [name, statSync(join(work, name)).size])
  const stopped = snapshot()
  assert.ok(stopped.length > 0, 'Pause check must inspect actual segment files')
  await delay(300)
  assert.deepEqual(snapshot(), stopped, 'Writer appended after pause returned')
  await request('setBandwidth', { taskID: paused.id, bandwidthLimit: 0 })
  await request('resume', { taskID: paused.id })
  const resumed = await waitComplete(paused.id)
  assert.equal(digest(readFileSync(join(resumed.folderPath, resumed.filename))), digest(payload))
  console.log(JSON.stringify({ passed: true, root, hostBinary, limitedMs: elapsed, pauseMs, sha256: digest(payload) }))
} finally {
  host?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
