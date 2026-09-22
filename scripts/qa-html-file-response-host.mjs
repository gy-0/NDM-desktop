// Real isolated Host: HTML returned for file downloads must not become a successful archive.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-html-response-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
const home = join(root, 'home')
await mkdir(support); await mkdir(downloads); await mkdir(home)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.from('<!doctype html><html><body>Sign in to continue</body></html>')
const received = []
const server = createServer((req, res) => {
  received.push({ path: req.url, method: req.method })
  if (req.url === '/redirect.zip') { res.writeHead(302, { Location: '/login' }); res.end(); return }
  res.writeHead(200, { 'Content-Type': req.url === '/changed-after-head.zip' && req.method === 'HEAD' ? 'application/zip' : 'text/html; charset=utf-8', 'Content-Length': payload.length })
  res.end(req.method === 'HEAD' ? undefined : payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const host = spawn(binary, [], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
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
  const observed = []
  for (const filename of ['document.zip', 'changed-after-head.zip', 'redirect.zip', 'saved-page.html']) {
    const result = await request('add', { url: `${base}/${filename}`, folderPath: downloads, filename, autoStart: true })
    assert.equal(result.ok, true)
    const task = await until('terminal download state', async () => (await request('list')).tasks.find(task => task.id === result.task.id && ['error','complete'].includes(task.status)))
    observed.push({ requested: filename, status: task.status, filename: task.filename, errorText: task.errorText, diagnostic: task.diagnostic,
      htmlPublished: task.status === 'complete' && (await readFile(join(task.folderPath,task.filename))).equals(payload) })
  }
  console.log(JSON.stringify({ observed, files: await readdir(downloads), received }))
  if (!process.argv.includes('--capture-baseline')) {
    for (const row of observed.slice(0, -1)) {
      assert.equal(row.status, 'error', 'HTML must not be published as a successful archive')
      assert.equal(row.errorText, '#diag:unexpectedWebPage')
      assert.equal(row.diagnostic?.primaryAction, 'openPage')
      assert.equal(row.htmlPublished, false)
    }
    assert.equal(observed.at(-1).status, 'complete', 'An intentional HTML download must still work')
    assert.equal(observed.at(-1).htmlPublished, true)
    assert.deepEqual(await readdir(downloads), ['saved-page.html'], 'Rejected webpage responses must not publish files')
    console.log(JSON.stringify({ passed: true, guardedProbeAndTransfer: true, intentionalHTMLPreserved: true }))
  }

} finally {
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true, hostStopped: host.exitCode !== null || host.signalCode !== null }))
}
