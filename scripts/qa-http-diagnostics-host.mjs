// Real isolated Host classification of local HTTP authentication failures.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-http-diagnostics-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const server = createServer((req, res) => {
  const status = req.url === '/proxy.bin' ? 407 : 401
  res.writeHead(status, { 'Content-Length': 0,
    ...(status === 407 ? { 'Proxy-Authenticate': 'Basic realm="local-fixture"' } : { 'WWW-Authenticate': 'Basic realm="local-fixture"' }) })
  res.end()
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
  const rows = []
  for (const kind of ['site', 'proxy']) {
    const result = await request('add', { url: `${base}/${kind}.bin`, pageURL: 'https://example.com/download', folderPath: downloads, filename: `${kind}.bin`, autoStart: true })
    assert.equal(result.ok, true)
    const failed = await until(`${kind} authentication diagnostic`, async () => (await request('list')).tasks.find(task => task.id === result.task.id && task.status === 'error'))
    rows.push({ kind, errorText: failed.errorText, diagnostic: failed.diagnostic })
  }
  console.log(JSON.stringify({ observed: rows }))
  if (!process.argv.includes('--capture-baseline')) {
    assert.equal(rows[0].diagnostic.primaryAction, 'openPage', 'Website sign-in keeps browser recovery')
    assert.equal(rows[1].diagnostic.primaryAction, 'retry', 'Proxy sign-in must not ask to recover the website')
    assert.match(rows[1].diagnostic.title, /proxy|代理/i)
    assert.match(rows[1].diagnostic.message, /proxy|代理/i)
    assert.equal((await request('list')).tasks.length, 2)
    console.log(JSON.stringify({ passed: true, websiteAuthenticationPreserved: true, proxyAuthenticationSeparated: true }))
  }
} finally {
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, hostStopped: host.exitCode !== null || host.signalCode !== null }))
}
