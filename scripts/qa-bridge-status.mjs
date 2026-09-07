// Real isolated NDMHost: a successful HTTP upgrade, not merely an installed
// extension directory or pending TCP handshake, determines connected status.
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}
const hostPort = await freePort()
let bridgePort = await freePort()
while (bridgePort === hostPort) bridgePort = await freePort()
const support = mkdtempSync(join(tmpdir(), 'ndm-bridge-status-'))
const host = spawn(resolve('native/.build/debug/NDMHost'), [], { env: {
  ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort),
  NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
}, stdio: ['ignore', 'ignore', 'pipe'] })
let hostLog = ''
host.stderr.on('data', chunk => { hostLog = (hostLog + chunk.toString()).slice(-2000) })
let startupError
host.on('error', error => { startupError = error })
function status() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: hostPort })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('Host status timed out')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write('{"id":919,"op":"getBridgeStatus"}\n'))
    socket.on('data', text => {
      buffer += text
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n')
        let message
        try { message = JSON.parse(buffer.slice(0, end)) } catch (error) { socket.destroy(); reject(error); return }
        buffer = buffer.slice(end + 1)
        if (message.id === 919) { socket.destroy(); resolve(message.bridge); return }
      }
    })
  })
}
async function expectClients(count) {
  let lastValue
  for (let i = 0; i < 50; i++) {
    if (startupError) throw startupError
    const value = await status().catch(() => null)
    lastValue = value
    if (value?.available && value.port === bridgePort && value.connectedClients === count) return
    await delay(100)
  }
  assert.fail(`Expected ready bridge with ${count} clients; got ${JSON.stringify(lastValue)}; host exit ${host.exitCode}; ${hostLog}`)
}
let raw, websocket
try {
  await expectClients(0)
  raw = createConnection({ host: '127.0.0.1', port: bridgePort })
  raw.on('error', () => {})
  await new Promise(done => raw.once('connect', done))
  await expectClients(0)
  websocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, 'ndm.open.v1')
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', () => reject(new Error('Isolated bridge handshake failed')), { once: true })
  })
  await expectClients(1)
  assert.deepEqual((await status()).relayClients, [], 'A plain WebSocket must not prove a running Relay version')
  const acknowledgement = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Relay version acknowledgement timed out')), 2000)
    websocket.addEventListener('message', event => {
      if (!String(event.data).startsWith('NDMRelayStatus:')) return
      clearTimeout(timeout)
      resolve(JSON.parse(String(event.data).slice('NDMRelayStatus:'.length)))
    }, { once: true })
  })
  websocket.send('NDMRelayHello:' + JSON.stringify({ version: '1.0.0', protocol: 1, role: 'worker' }))
  const ack = await acknowledgement
  const identified = await status()
  assert.equal(ack.protocol, 1)
  assert.equal(ack.expectedVersion, identified.expectedRelayVersion)
  assert.deepEqual(identified.relayClients, [{ version: '1.0.0', protocol: 1, role: 'worker' }], 'Retain an old running version instead of replacing it with the installed manifest version')
  websocket.close()
  await expectClients(0)
  assert.deepEqual((await status()).relayClients, [], 'Disconnected worker identities must not persist')
  console.log('PASS isolated host reports waiting → unidentified → running worker version → disconnected; pending TCP and plain WebSocket never prove Relay version')
} finally {
  raw?.destroy()
  websocket?.close()
  host.kill('SIGTERM')
}
