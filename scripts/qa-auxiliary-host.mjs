// Real Host + main-service boundary QA; no production state or renderer mocks.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary built from this worktree.')
// Pass the packaged Resources/Tools directory to verify the actual bundle's
// helper, source manifest and license gate instead of the repository tools.
const toolsDirectory = resolve(process.argv[3] ?? 'native/Vendor/Tools')
const root = await mkdtemp(join(tmpdir(), 'ndm-auxiliary-host-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
await build({ entryPoints: ['src/main/auxiliaryTools.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'auxiliary-tools.mjs') })
const { AuxiliaryToolsService } = await import(pathToFileURL(join(root, 'auxiliary-tools.mjs')).href)
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const freePort = async () => {
  const server = createTCPServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(1024 * 1024)
for (let index = 0; index < payload.length; index++) payload[index] = index % 239
let requests = 0
const fixture = createServer((req, res) => {
  if (req.url !== '/fixture.bin') { res.writeHead(404); res.end(); return }
  requests++
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const encode = value => {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return encode(Buffer.from(value))
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')])
}
const pieces = []
for (let offset = 0; offset < payload.length; offset += 16384) pieces.push(createHash('sha1').update(payload.subarray(offset, offset + 16384)).digest())
const torrent = encode({ info: { name: 'fixture.bin', private: 1, length: payload.length, 'piece length': 16384, pieces: Buffer.concat(pieces) }, 'url-list': `http://127.0.0.1:${fixture.address().port}/fixture.bin` })
const torrentPath = join(root, 'fixture.torrent')
await writeFile(torrentPath, torrent)
const environment = { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort),
  NDM_DISABLE_LEGACY_BRIDGE: '1', NDM_TOOL_DIR: toolsDirectory, NDM_AUXILIARY_PEER_DISCOVERY: '0', NDM_AUXILIARY_LOOPBACK_ONLY: '1' }
const host = spawn(binary, [], { env: environment, stdio: 'ignore' })
const hostExit = once(host, 'exit')
let sequence = 0
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const socket = createConnection({ host: '127.0.0.1', port: hostPort })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Host ${op} timeout`)) }, 20000)
  let input = ''
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ ...extra, id, op }) + '\n'))
  socket.on('data', chunk => {
    input += chunk
    while (input.includes('\n')) {
      const index = input.indexOf('\n'), line = input.slice(0, index); input = input.slice(index + 1)
      let reply
      try { reply = JSON.parse(line) } catch { continue }
      if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolve(reply); return }
    }
  })
})
const service = new AuxiliaryToolsService({ request, chooseTorrent: async () => torrentPath, platform: 'posix' })
const until = async (description, predicate) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await predicate()
    if (result) return result
    await pause(100)
  }
  throw new Error(`Timed out: ${description}`)
}
try {
  await until('Host startup', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  const capabilities = await service.request('auxiliaryCapabilities')
  assert.equal(capabilities.capabilities?.bittorrent, true, JSON.stringify(capabilities))
  const selected = await service.request('auxiliaryChooseTorrent')
  const intent = { creationKey: randomUUID(), source: { kind: 'torrent', token: selected.torrent.token }, folderPath: downloads, autoStart: false }
  const created = await service.request('auxiliaryCreate', intent)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal((await service.request('auxiliaryCreate', intent)).taskID, created.taskID)
  const status = () => service.request('auxiliaryStatus', { taskID: created.taskID })
  const waiting = await until('file selection gate', async () => { const reply = await status(); return reply.snapshot?.phase === 'awaitingSelection' && reply.snapshot })
  assert.equal(requests, 0, 'BT payload must wait for explicit selection')
  assert.equal(waiting.files.length, 1)
  assert.equal((await service.request('auxiliarySelectFiles', { taskID: created.taskID, generation: waiting.generation, indices: [1], autoStart: true })).ok, true)
  await until('seed state after payload', async () => { const reply = await status(); return reply.snapshot?.phase === 'seeding' && reply.snapshot.payloadCompleted })
  const seedingTask = (await request('list')).tasks.find(task => task.id === created.taskID)
  assert.equal(seedingTask.status, 'downloading')
  assert.equal(seedingTask.linkType, 'bittorrent')
  assert.equal((await service.request('auxiliaryStopSeeding', { taskID: created.taskID, generation: waiting.generation })).ok, true)
  await until('final publication', async () => (await status()).snapshot?.phase === 'complete')
  const finalTask = (await request('list')).tasks.find(task => task.id === created.taskID)
  assert.equal(finalTask.status, 'complete')
  assert.equal(finalTask.folderPath, downloads)
  assert.deepEqual(await readFile(join(finalTask.folderPath, finalTask.filename)), payload)
  console.log(JSON.stringify({ passed: true, taskID: finalTask.id, bytes: payload.length, metadataGateZeroRequests: true,
    singleCreationReceipt: true, helperSeedingNotTaskComplete: true, finalSHA256: createHash('sha256').update(payload).digest('hex') }))
} finally {
  service.dispose()
  await request('pauseAll').catch(() => undefined)
  host.kill('SIGTERM'); await hostExit
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
  const ownedHelpers = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes('aria2-next') && line.includes(`--state-dir=${support}/`))
  await until('owned helper exit', async () => ownedHelpers().length === 0)
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  const domain = `ndm.support.${hash.toString(16)}`
  // Only the owned QA UserDefaults domain; absence is fine.
  try { execFileSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' }) } catch { /* No settings written. */ }
  await rm(root, { recursive: true, force: true })
}
