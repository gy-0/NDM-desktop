// Independent Digest signature verification through the real host bridge. Never uses the user's host, ports or library.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-digest-host-'))
const downloads = join(root, 'downloads')
mkdirSync(downloads)
const payload = randomBytes(4 * 1024 * 1024)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const etag = '"' + digest(payload) + '"'
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
let host
const accepted = [], rejected = [], seen = new Set()
let algorithm = 'MD5'
const realm = 'NDM isolated fixture', nonce = 'fixed-local-fixture-nonce'
const hash = value => createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5').update(value).digest('hex')
const server = httpServer((request, response) => {
  const authorization = request.headers.authorization
  const challenge = () => {
    response.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", algorithm=${algorithm}, qop="auth"`, 'Content-Length': 0 })
    response.end()
  }
  if (!authorization || authorization.startsWith('Basic ')) { challenge(); return }
  const fields = Object.fromEntries([...authorization.matchAll(/(\w+)=(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^,\s]+))/g)].map(match => [match[1], match[2] ?? match[3]]))
  const expected = hash(`${hash(`fixture:${realm}:fixture-password`)}:${nonce}:${fields.nc}:${fields.cnonce}:auth:${hash(`${request.method}:${request.url}`)}`)
  const replayKey = `${algorithm}/${fields.nonce}/${fields.cnonce}/${fields.nc}`
  if (!authorization.startsWith('Digest ') || fields.username !== 'fixture' || fields.realm !== realm ||
      fields.nonce !== nonce || fields.uri !== request.url || fields.qop !== 'auth' ||
      fields.algorithm?.toUpperCase() !== algorithm || !/^[0-9a-f]{8}$/i.test(fields.nc || '') ||
      !fields.cnonce || fields.response !== expected || seen.has(replayKey)) {
    rejected.push({ method: request.method, target: request.url, algorithm, replay: seen.has(replayKey) })
    challenge(); return
  }
  seen.add(replayKey)
  accepted.push({ method: request.method, target: request.url, algorithm, range: request.headers.range })
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : 0
  const end = match ? Number(match[2]) : payload.length - 1
  response.writeHead(match ? 206 : 200, {
    'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes', ETag: etag,
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  response.end(request.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
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
  for (const mode of ['MD5', 'SHA-256']) {
    algorithm = mode
    const task = (await request('add', {
      url: `http://fixture:fixture-password@127.0.0.1:${server.address().port}/encoded%2Ffile%20name.bin?part=1&token=a%2Bb`,
      filename: `${mode}.bin`, folderPath: downloads, connections: 4, autoStart: true
    })).task
    let complete
    for (let i = 0; i < 200; i++) {
      const current = (await request('list')).tasks.find(item => item.id === task.id)
      assert.notEqual(current?.status, 'error', `${mode}: ${current?.errorText}; rejected=${JSON.stringify(rejected)}`)
      if (current?.status === 'complete') { complete = current; break }
      await delay(100)
    }
    assert.ok(complete, `${mode} never completed`)
    assert.equal(digest(readFileSync(join(complete.folderPath, complete.filename))), digest(payload))
    const observations = accepted.filter(item => item.algorithm === mode)
    assert.ok(observations.some(item => item.method === 'HEAD'), 'Authenticated HEAD missing')
    assert.ok(observations.filter(item => item.method === 'GET' && item.range).length >= 4, 'Four authenticated ranges missing')
    assert.ok(observations.every(item => item.target.includes('%2F') && item.target.endsWith('?part=1&token=a%2Bb')))
  }
  assert.deepEqual(rejected, [], 'Server observed invalid signatures or replays')
  console.log(JSON.stringify({ passed: true, root, hostBinary, accepted, sha256: digest(payload) }))
} finally {
  host?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
