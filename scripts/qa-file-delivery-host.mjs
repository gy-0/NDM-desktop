// Characterize real Host collision handling without touching user files.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-file-delivery-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payloads = { '/a.bin': Buffer.alloc(1024 * 1024, 0x61), '/b.bin': Buffer.alloc(1024 * 1024, 0x62) }
const server = createServer((req, res) => {
  const payload = payloads[req.url]
  if (!payload) { res.writeHead(404); res.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: `"${req.url}"`, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
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
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, categorySubfolders: false, downloadAllAtOnce: true })).ok, true)
  const original = Buffer.from('Existing user file must survive')
  const filename = 'same-name.bin', existingPath = join(downloads, filename)
  await writeFile(existingPath, original)
  const replies = await Promise.all(Object.keys(payloads).map(path => request('add', { url: base + path, filename, folderPath: downloads, connections: 4, autoStart: true })))
  assert.ok(replies.every(reply => reply.ok && reply.task?.id), JSON.stringify(replies))
  const ids = replies.map(reply => reply.task.id)
  const settled = await until('both same-name downloads settle', async () => {
    const tasks = (await request('list')).tasks.filter(task => ids.includes(task.id))
    return tasks.length === 2 && tasks.every(task => task.status === 'complete' || task.status === 'error') ? tasks : null
  })
  assert.deepEqual(await readFile(existingPath), original)
  const completed = settled.filter(task => task.status === 'complete')
  const collisions = settled.filter(task => task.status === 'error')
  assert.ok(collisions.every(task => task.errorText === '#diag:fileAlreadyExists'))
  assert.equal(new Set(completed.map(task => join(task.folderPath, task.filename))).size, completed.length)
  for (const task of completed) {
    assert.notEqual(join(task.folderPath, task.filename), existingPath)
    assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payloads[new URL(task.url).pathname])
  }
  console.log(JSON.stringify({ safetyPassed: true, existingFilePreserved: true, successfulFilesHaveExactBytes: true, completed: completed.length, collisionErrors: collisions.length, autoNumberingSatisfied: completed.length === 2, filenames: completed.map(task => task.filename) }))
} finally {
  await request('pauseAll').catch(() => {})
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
