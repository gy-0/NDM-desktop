// Real isolated Host + Electron missing-file UI + local payload.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ui
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-missing-file-'))
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
  const added = await request('add', { url: mediaURL, filename: 'moved-download.txt', folderPath: downloads, autoStart: true })
  assert.equal(added.ok, true)
  const completed = await until('fixture download', async () => (await request('list')).tasks.find(task => task.status === 'complete'))
  const original = join(completed.folderPath, completed.filename), moved = join(root, 'moved-aside.txt')
  await rename(original, moved)
  assert.deepEqual(await readFile(moved), payload)
  ui = spawn('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', ['.', `--user-data-dir=${join(root, 'electron')}`], {
    env: { ...process.env, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_SUPPORT_DIR: support, NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore'
  })
  console.log(JSON.stringify({ uiReady: true, missingFile: true, root, original, moved, hostPort, manualCheck: 'Check open, context menu and reveal feedback; send done on stdin to finish.' }))
  await new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      process.stdin.removeListener('data', finish)
      ui.removeListener('exit', finish)
      resolve()
    }
    const timer = setTimeout(finish, 10 * 60 * 1000)
    process.stdin.once('data', finish)
    ui.once('exit', finish)
    if (ui.exitCode !== null || ui.signalCode !== null) finish()
    else process.stdin.resume()
  })
  process.stdin.pause()
  assert.deepEqual(await readFile(moved), payload)
  const tasks = (await request('list')).tasks
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'complete')
  console.log(JSON.stringify({ fixtureUnchanged: true, movedBytesPreserved: true, tasks: 1 }))
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
