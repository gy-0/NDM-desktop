import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const aria2Path = '/opt/homebrew/bin/aria2c'
if (!existsSync(aria2Path)) throw new Error('本机缺少 aria2c，无法执行 Windows 引擎协议 QA')

const temporary = await mkdtemp(join(tmpdir(), 'ndm-windows-engine-qa-'))
const bundle = join(temporary, 'windows-engine.mjs')
await build({
  entryPoints: ['src/main/windows/windowsEngine.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle
})
const { WindowsDownloadEngine } = await import(pathToFileURL(bundle).href)

const payload = Buffer.allocUnsafe(8 * 1024 * 1024)
for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
const expectedHash = createHash('sha256').update(payload).digest('hex')

const server = createServer((request, response) => {
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Math.min(payload.length - 1, Number(range[2])) : payload.length - 1
  response.statusCode = range ? 206 : 200
  response.setHeader('accept-ranges', 'bytes')
  response.setHeader('content-type', 'application/octet-stream')
  response.setHeader('content-length', end - start + 1)
  if (range) response.setHeader('content-range', `bytes ${start}-${end}/${payload.length}`)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  let offset = start
  const timer = setInterval(() => {
    if (offset > end || response.destroyed) {
      clearInterval(timer)
      if (!response.destroyed) response.end()
      return
    }
    const next = Math.min(end + 1, offset + 64 * 1024)
    response.write(payload.subarray(offset, next))
    offset = next
  }, 40)
  response.on('close', () => clearInterval(timer))
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert.ok(address && typeof address === 'object')

let latestStatus = 'connecting'
const snapshots = []
let resolveLive
const live = new Promise((resolveValue) => { resolveLive = resolveValue })
const engine = new WindowsDownloadEngine({
  stateDirectory: join(temporary, 'state'),
  defaultDownloadDirectory: join(temporary, 'downloads'),
  aria2Path,
  ytDlpPath: '/Users/gaoyuan/NDM/Vendor/Tools/yt-dlp',
  rpcPort: 52000 + Math.floor(Math.random() * 1000)
}, {
  onStatus(status) {
    latestStatus = status
    if (status === 'live') resolveLive()
  },
  onEvent(message) {
    if (message.op === 'snapshot') snapshots.push(message.tasks)
  }
})

const waitFor = async (predicate, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const reply = await engine.request('list')
    const task = reply.tasks?.[0]
    if (task && predicate(task)) return task
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('等待 Windows 引擎状态超时')
}

try {
  void engine.start()
  await Promise.race([
    live,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`引擎未启动：${latestStatus}`)), 8_000))
  ])
  const added = await engine.request('add', {
    url: `http://127.0.0.1:${address.port}/payload.bin`,
    filename: 'Windows 引擎 QA.bin',
    connections: 2
  })
  assert.equal(added.ok, true)
  const active = await waitFor((task) => task.status === 'downloading' && task.completedBytes > 0)
  await engine.request('pause', { taskID: active.id })
  const paused = await waitFor((task) => task.status === 'paused')
  assert.ok(paused.completedBytes > 0 && paused.completedBytes < payload.length)
  await engine.request('resume', { taskID: active.id })
  const completed = await waitFor((task) => task.status === 'complete', 30_000)
  assert.equal(completed.completedBytes, payload.length)
  assert.equal(completed.fileSize, payload.length)
  const actual = await readFile(join(temporary, 'downloads', 'Windows 引擎 QA.bin'))
  assert.equal(createHash('sha256').update(actual).digest('hex'), expectedHash)
  assert.ok(snapshots.length > 2)
  console.log(JSON.stringify({
    engine: 'aria2 RPC',
    pauseResume: 'passed',
    bytes: payload.length,
    sha256: expectedHash,
    snapshots: snapshots.length
  }, null, 2))
} finally {
  engine.stop()
  await new Promise((resolveClose) => server.close(resolveClose))
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  await rm(temporary, { recursive: true, force: true })
}
