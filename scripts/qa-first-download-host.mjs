// Real isolated Host + Electron first-run UI + local payload.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ui
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-first-download-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(512 * 1024, 0x73), received = []
const server = createServer((req, res) => {
  received.push({ path: req.url, cookie: req.headers.cookie, referer: req.headers.referer, userAgent: req.headers['user-agent'] })
  if (req.url === '/expired.bin') { res.writeHead(403); res.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'text/plain', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"page-media-fixture"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const mediaURL = `http://127.0.0.1:${server.address().port}/first-download.txt`
const host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
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
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, categorySubfolders: false })).ok, true)
  ui = spawn('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', ['.', `--user-data-dir=${join(root, 'electron')}`], {
    env: { ...process.env, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_SUPPORT_DIR: support, NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore'
  })
  console.log(JSON.stringify({ uiReady: true, mediaURL, root, downloads, hostPort }))
  let task
  for (let n = 0; n < 1800; n++) {
    const tasks = (await request('list')).tasks
    assert.ok(tasks.length <= 1, 'first action must not create duplicate tasks')
    task = tasks.find(item => item.status === 'complete')
    if (task) break
    await delay(500)
  }
  assert.ok(task, 'Complete a first download through the UI within fifteen minutes')
  assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payload)
  console.log(JSON.stringify({ passed: true, filename: task.filename, exactBytes: payload.length, tasks: 1 }))
  await delay(30000)
} finally {
  if (ui && ui.exitCode === null && ui.signalCode === null) { const done = once(ui, 'exit'); ui.kill('SIGTERM'); await done }
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
