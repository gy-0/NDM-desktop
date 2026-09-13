// Starts an isolated real app for manual/CUA verification. No production data is copied.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const hostBinary = process.argv[2]
if (!hostBinary) throw new Error('Pass the isolated NDMHost release binary path.')
const root = await mkdtemp(join(tmpdir(), 'ndm-download-tools-qa-'))
const support = join(root, 'engine')
const downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const freePort = async () => {
  const server = createTCPServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(1024 * 1024, 0x53)
const digest = createHash('sha256').update(payload).digest('hex')
const fixture = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', 'ETag': '"ndm-checksum-fixture-v1"',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  if (req.method === 'HEAD') res.end(); else res.end(payload.subarray(start, end + 1))
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const hostLog = createWriteStream(join(root, 'host.log'))
const host = spawn(hostBinary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
host.stdout.pipe(hostLog); host.stderr.pipe(hostLog)
let electron
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  electron?.kill('SIGTERM'); host.kill('SIGTERM')
  fixture.closeAllConnections(); fixture.close()
  hostLog.end()
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
process.on('uncaughtException', error => { console.error(error); void stop(); process.exitCode = 1 })
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port: hostPort })
  let input = ''
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('Host timeout')) }, 10_000)
  const finish = () => clearTimeout(timer)
  socket.on('error', error => { finish(); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ id: 100, op, ...extra }) + '\n'))
  socket.on('data', chunk => {
    input += chunk
    while (input.includes('\n')) {
      const index = input.indexOf('\n'), line = input.slice(0, index); input = input.slice(index + 1)
      let reply
      try { reply = JSON.parse(line) } catch { continue }
      if (reply.id === 100) { finish(); socket.destroy(); resolve(reply); break }
    }
  })
})
try {
  for (let i = 0; ; i++) {
    try { await request('getSettings'); break }
    catch (error) { if (i > 80) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const settings = await request('updateSettings', { downloadDirectory: downloads, useCategoryFolders: false, installerSourceDisposition: 'keep' })
  if (!settings.ok) throw new Error(JSON.stringify(settings))
  const created = await request('add', { url: `http://127.0.0.1:${fixture.address().port}/integrity-fixture.bin`, filename: 'integrity-fixture.bin', connections: 2 })
  if (!created.ok) throw new Error(JSON.stringify(created))
  for (let i = 0; ; i++) {
    const reply = await request('list')
    const task = reply.tasks?.find(task => task.id === created.task.id)
    if (task?.status === 'complete') break
    if (task?.status === 'error' || i > 100) throw new Error(JSON.stringify(task))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const metadata = { root, hostPort, bridgePort, fixturePort: fixture.address().port, digest, taskID: created.task.id }
  await writeFile('/tmp/ndm-download-tools-qa-current.json', JSON.stringify(metadata, null, 2))
  await writeFile(join(root, 'import-settings.json'), JSON.stringify({ format: 'ndm-settings', version: 1, appVersion: 'qa', exportedAt: new Date().toISOString(), settings: { maxConnections: 8, bandwidthLimitBytesPerSecond: 131072 } }, null, 2))
  const electronLog = createWriteStream(join(root, 'electron.log'))
  electron = spawn(join(cwd, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), ['.', `--user-data-dir=${root}/electron`], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  electron.stdout.pipe(electronLog); electron.stderr.pipe(electronLog)
  electron.on('exit', () => { electronLog.end(); void stop() })
  console.log(JSON.stringify(metadata))
} catch (error) { await stop(); throw error }
