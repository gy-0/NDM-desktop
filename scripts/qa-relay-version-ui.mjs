// Real isolated Host + Electron Relay version UI.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ui, relay
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-relay-version-ui-'))
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
  const connect = async version => {
    relay?.close()
    await until('disconnected', async () => (await request('getBridgeStatus')).bridge.connectedClients === 0)
    if (version === 'disconnect') return
    relay = new WebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, 'ndm.open.v1')
    await once(relay, 'open')
    relay.send('NDMRelayHello:' + JSON.stringify({ version, protocol: 1, role: 'worker' }))
    await until('worker identity', async () => (await request('getBridgeStatus')).bridge.relayClients.some(client => client.version === version))
  }
  const expected = (await request('getBridgeStatus')).bridge.expectedRelayVersion
  await connect('1.0.0')
  console.log(JSON.stringify({ uiReady: true, root, expected, commands: 'Enter newer, match, disconnect, older, or done. Inspect UI using CUA.' }))
  const { createInterface } = await import('node:readline')
  const lines = createInterface({ input: process.stdin })
  const timer = setTimeout(() => lines.close(), 15 * 60 * 1000)
  ui.once('exit', () => lines.close())
  try {
    for await (const line of lines) {
      const command = line.trim()
      if (command === 'done') break
      const version = { older: '1.0.0', newer: '2.0.0', match: expected, disconnect: 'disconnect' }[command]
      if (version) { await connect(version); console.log(JSON.stringify({ phase: command, version })) }
    }
  } finally { clearTimeout(timer); lines.close() }
  assert.equal((await request('list')).tasks.length, 0)
  console.log(JSON.stringify({ fixtureUnchanged: true, tasks: 0 }))

} finally {
  relay?.close()
  if (ui && ui.exitCode === null && ui.signalCode === null) { const done = once(ui, 'exit'); ui.kill('SIGTERM'); await done }
  host.kill('SIGTERM'); await exited
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
