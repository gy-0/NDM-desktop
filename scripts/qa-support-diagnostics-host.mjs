// Real isolated Host + Electron support export UI.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ui
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-support-ui-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
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
  const reportPath = join(root, 'NDM-support.txt')
  console.log(JSON.stringify({ uiReady: true, root, reportPath, hostPort }))
  let report
  for (let n = 0; n < 1800; n++) {
    try { report = await readFile(reportPath, 'utf8'); break } catch { await delay(500) }
  }
  assert.ok(report, 'Export diagnostic using the native save dialog within fifteen minutes')
  assert.match(report, /NDM 支持诊断/)
  assert.match(report, /下载引擎：已响应/)
  assert.match(report, /任务总数：0/)
  assert.doesNotMatch(report, /127\.0\.0\.1|https?:|\/Users\/|\/var\/|Cookie:/)
  console.log(JSON.stringify({ passed: true, nativeSave: true, reportBytes: Buffer.byteLength(report), privacyAllowlist: true }))
  await delay(30000)
} finally {
  if (ui && ui.exitCode === null && ui.signalCode === null) { const done = once(ui, 'exit'); ui.kill('SIGTERM'); await done }
  host.kill('SIGTERM'); await exited
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
