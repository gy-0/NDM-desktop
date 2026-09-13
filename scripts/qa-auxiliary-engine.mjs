// Runs only a supplied, digest-pinned engine against an isolated loopback fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const binary = process.argv[2]
assert(binary, 'Pass the Aria2 Next 2.7.5 macOS arm64 binary path.')
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343')
const root = await mkdtemp(join(tmpdir(), 'ndm-auxiliary-contract-'))
const destination = join(root, 'files')
await mkdir(destination)
const payload = Buffer.alloc(256 * 1024, 0x53)
const secret = randomBytes(24).toString('hex')
const server = createServer((request, response) => {
  if (request.url !== '/payload.bin') { response.writeHead(404); response.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  const body = payload.subarray(start, end + 1)
  response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
    'Accept-Ranges': 'bytes', ETag: '"ndm-auxiliary-fixture"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  response.end(request.method === 'HEAD' ? undefined : body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const fixturePort = server.address().port
const portProbe = createServer()
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
const port = portProbe.address().port
await new Promise(resolve => portProbe.close(resolve))
let child
let exitPromise
let log = ''
let sequence = 0
const rpc = async (method, params = []) => {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: `aria2.${method}`, params: [`token:${secret}`, ...params] }) })
  const reply = await response.json()
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
  return reply.result
}
const start = async () => {
  child = spawn(binary, ['--no-conf=true', '--enable-rpc=true', `--rpc-listen-port=${port}`, '--rpc-listen-all=false',
    `--rpc-secret=${secret}`, `--state-dir=${join(root, 'state')}`, `--dir=${destination}`, `--stop-with-process=${process.pid}`,
    '--enable-dht=false', '--bt-enable-lpd=false', '--disable-ipv6=true', '--console-log-level=warn'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  exitPromise = once(child, 'exit')
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await rpc('getVersion') } catch { if (child.exitCode !== null) break; await delay(100) }
  }
  throw new Error('Isolated auxiliary engine failed to start.')
}
const stop = async () => {
  if (!child || child.exitCode !== null) return
  await rpc('shutdown').catch(() => undefined)
  let exited = false
  await Promise.race([exitPromise.then(() => { exited = true }), delay(5000)])
  if (!exited) { child.kill('SIGTERM'); await exitPromise }
}
try {
  const version = await start()
  assert.equal(version.version, '2.7.5')
  const gid = '0123456789abcdef'
  assert.equal(await rpc('addUri', [[`http://127.0.0.1:${fixturePort}/missing.bin`, `http://127.0.0.1:${fixturePort}/payload.bin`],
    { gid, out: 'payload.bin', pause: 'true', split: '2', 'max-tries': '1', 'retry-wait': '0' }]), gid)
  assert.equal((await rpc('tellStatus', [gid])).status, 'paused')
  await stop()
  await start()
  // state-dir stores transfer bytes/metadata; NDM's durable task ledger must
  // replay admission with the same fixed GID before querying or resuming it.
  await assert.rejects(rpc('tellStatus', [gid]), /not found/)
  assert.equal(await rpc('addUri', [[`http://127.0.0.1:${fixturePort}/missing.bin`, `http://127.0.0.1:${fixturePort}/payload.bin`],
    { gid, out: 'payload.bin', pause: 'true', split: '2', 'max-tries': '1', 'retry-wait': '0' }]), gid)
  const restored = await rpc('tellStatus', [gid])
  assert.equal(restored.status, 'paused')
  await rpc('unpause', [gid])
  let status
  for (let attempt = 0; attempt < 150; attempt++) {
    status = await rpc('tellStatus', [gid])
    if (status.status === 'complete' || status.status === 'error') break
    await delay(100)
  }
  const mirrorProbe = { status: status.status, errorCode: status.errorCode }
  // The pinned fork currently stops at the first 404 even with another mirror.
  // Keep this fact visible; the NDM adapter must implement and test fallback.
  assert.equal(status.status, 'error')
  assert.equal(status.errorCode, '3')
  const directGID = await rpc('addUri', [[`http://127.0.0.1:${fixturePort}/payload.bin`], { out: 'payload.bin', 'stream-max-connections': '2' }])
  for (let attempt = 0; attempt < 150; attempt++) {
    status = await rpc('tellStatus', [directGID])
    if (status.status === 'complete' || status.status === 'error') break
    await delay(100)
  }
  assert.equal(status.status, 'complete', `Unexpected direct-transfer status ${status.status}, code ${status.errorCode}`)
  assert.deepEqual(await readFile(join(destination, 'payload.bin')), payload)
  await writeFile(join(root, 'result.json'), JSON.stringify({ version, gid, ledgerReplayRestoredPausedTask: true, mirrorProbe, directTransferBytes: payload.length }, null, 2))
  process.stdout.write(JSON.stringify({ ok: true, root, bytes: payload.length, restoredGID: gid }) + '\n')
} finally {
  await stop()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  // Fixture-only logs never include the RPC secret.
  await writeFile(join(root, 'engine.log'), log.replaceAll(secret, '[redacted]'))
}
