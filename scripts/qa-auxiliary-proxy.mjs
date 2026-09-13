// Isolated pinned-engine proxy QA. No dependencies beyond Node builtins and the
// existing read-only Paramiko fixture. Never routes a proxy request to the internet.
// Run from the repository: NDM_SFTP_FIXTURE_PYTHON=/path/to/venv/bin/python \
//   node scripts/qa-auxiliary-proxy.mjs /path/to/pinned/aria2-next
// NDM_PROXY_QA_ONLY=sftp|bt narrows verification. Generated state, processes and
// listeners are removed in finally; only token-free JSON results reach stdout.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { createServer as createHTTPServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export function cleanProxyEnvironment(base = process.env, proxy) {
  const output = { ...base }
  for (const key of Object.keys(output)) if (/^(?:http|https|ftp|sftp|all|no)_proxy$/i.test(key)) delete output[key]
  if (proxy) output.ALL_PROXY = proxy
  return output
}
class Reader {
  buffer = Buffer.alloc(0)
  waiter
  error
  constructor(socket) {
    this.socket = socket
    this.data = data => { this.buffer = Buffer.concat([this.buffer, data]); this.wake() }
    this.close = () => { this.error = new Error('Fixture socket closed'); this.wake() }
    socket.on('data', this.data); socket.on('close', this.close)
  }
  wake() { this.waiter?.(); this.waiter = undefined }
  async take(count) {
    while (this.buffer.length < count) {
      if (this.error) throw this.error
      await new Promise(resolve => { this.waiter = resolve })
    }
    const data = this.buffer.subarray(0, count); this.buffer = this.buffer.subarray(count); return data
  }
  async until(ending, max = 65536) {
    while (true) {
      const index = this.buffer.indexOf(ending)
      if (index >= 0) return this.take(index + ending.length)
      if (this.buffer.length > max || this.error) throw this.error ?? new Error('Fixture handshake exceeded limit')
      await new Promise(resolve => { this.waiter = resolve })
    }
  }
  detach() { this.socket.off('data', this.data); this.socket.off('close', this.close); return this.buffer }
}
export class LocalAuxiliaryProxy {
  sockets = new Set()
  routes = []
  accepted = 0
  constructor({ ports = [], reject = false } = {}) {
    this.ports = new Set(ports); this.reject = reject
    this.server = createServer(socket => {
      this.accepted++; this.track(socket)
      socket.setTimeout(15000, () => socket.destroy())
      void this.handshake(socket).catch(() => socket.destroy())
    })
  }
  track(socket) { this.sockets.add(socket); socket.on('error', () => undefined); socket.once('close', () => this.sockets.delete(socket)); return socket }
  async start() { this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening'); this.port = this.server.address().port; return this }
  url(scheme = 'http') { return `${scheme}://127.0.0.1:${this.port}` }
  async stop() {
    const closed = this.server.listening ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve()
    const drained = [...this.sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy() }))
    await Promise.all([closed, ...drained])
    assert.equal(this.sockets.size, 0, 'Owned proxy connections must close')
  }
  async handshake(client) {
    const reader = new Reader(client), first = (await reader.take(1))[0]
    let host, port, kind, success, failure, initial = Buffer.alloc(0)
    if (first === 5) {
      const count = (await reader.take(1))[0], methods = await reader.take(count)
      if (!methods.includes(0)) { client.end(Buffer.from([5, 255])); return }
      client.write(Buffer.from([5, 0]))
      const header = await reader.take(4)
      if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) throw new Error('Unsupported fixture SOCKS command')
      if (header[3] === 3) host = (await reader.take((await reader.take(1))[0])).toString()
      else if (header[3] === 1) host = [...await reader.take(4)].join('.')
      else if (header[3] === 4) host = [...await reader.take(16)].map(value => value.toString(16).padStart(2, '0')).join('')
      else throw new Error('Unsupported fixture SOCKS address')
      port = (await reader.take(2)).readUInt16BE()
      kind = 'socks5'; success = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]); failure = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
    } else if (first === 4) {
      const header = await reader.take(7)
      if (header[0] !== 1) throw new Error('Unsupported fixture SOCKS4 command')
      port = header.readUInt16BE(1); host = [...header.subarray(3)].join('.')
      await reader.until(Buffer.from([0]), 512)
      if (header[3] === 0 && header[4] === 0 && header[5] === 0 && header[6] !== 0) host = (await reader.until(Buffer.from([0]), 512)).subarray(0, -1).toString()
      kind = 'socks4'; success = Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]); failure = Buffer.from([0, 91, 0, 0, 0, 0, 0, 0])
    } else {
      const header = Buffer.concat([Buffer.from([first]), await reader.until(Buffer.from('\r\n\r\n'))]).toString()
      const lines = header.trimEnd().split('\r\n'), [method, destination, version] = lines[0].split(' ')
      const tunnel = method === 'CONNECT', url = new URL(tunnel ? `http://${destination}` : destination)
      host = url.hostname; port = Number(url.port || (url.protocol === 'https:' ? 443 : 80)); kind = tunnel ? 'connect' : 'http'
      success = tunnel ? Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n') : Buffer.alloc(0)
      failure = Buffer.from('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      if (!tunnel) initial = Buffer.from([`${method} ${url.pathname}${url.search} ${version}`, ...lines.slice(1).filter(line => !/^proxy-authorization:/i.test(line)), '', ''].join('\r\n'))
    }
    const route = { kind, host, port, denied: this.reject || !this.ports.has(port), bytesUp: 0, bytesDown: 0 }
    this.routes.push(route)
    if (route.denied) { reader.detach(); client.end(failure); return }
    const upstream = this.track(connect({ host: '127.0.0.1', port }))
    upstream.pause()
    try { await once(upstream, 'connect') } catch { reader.detach(); client.end(failure); return }
    const buffered = reader.detach()
    client.write(success)
    if (initial.length) upstream.write(initial)
    if (buffered.length) upstream.write(buffered)
    client.on('data', data => { route.bytesUp += data.length }); upstream.on('data', data => { route.bytesDown += data.length })
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy())
    client.pipe(upstream); upstream.pipe(client); upstream.resume()
  }
}
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
async function terminate(child, exited) {
  if (!child.pid) { await exited; return }
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
  try { await exited } finally { clearTimeout(timer) }
}
export async function startAuxiliaryProxyEngine(binary, root, { env = cleanProxyEnvironment(), extra = [] } = {}) {
  await mkdir(root, { recursive: true })
  const files = join(root, 'files'); await mkdir(files, { recursive: true })
  const port = await freePort(), btPort = await freePort(), edPort = await freePort(), edUDP = await freePort()
  const secret = randomBytes(24).toString('hex')
  const child = spawn(binary, ['--no-conf=true', '--no-netrc=true', '--enable-rpc=true', '--rpc-listen-all=false', `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`,
    `--state-dir=${join(root, 'state')}`, `--dir=${files}`, `--listen-port=${btPort}`, `--ed2k-listen-port=${edPort}`, `--ed2k-udp-listen-port=${edUDP}`, `--stop-with-process=${process.pid}`,
    '--bt-interface=127.0.0.1', '--disable-ipv6=true', '--enable-dht=false', '--bt-enable-lpd=false', '--enable-peer-exchange=false', '--bt-port-mapping=false', '--max-tries=1', '--connect-timeout=3', '--timeout=5', '--console-log-level=error', '--summary-interval=0', '--show-console-readout=false', ...extra], { env, stdio: 'ignore' })
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) }); let launchError
  child.on('error', error => { launchError = error })
  const rpc = async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `aria2.${method}`, params: [`token:${secret}`, ...params] }) })
    const result = await response.json()
    if (result.error) throw new Error(`Fixture RPC ${method} failed (${Number(result.error.code)})`)
    return result.result
  }
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error('Fixture engine exited before readiness')
      try { await rpc('getVersion'); return { rpc, files, btPort, stop: () => terminate(child, exited) } } catch { await delay(50) }
    }
    throw new Error('Fixture engine readiness timed out')
  } catch (error) { await terminate(child, exited); throw error }
}
export async function startReadOnlySFTPFixture(python) {
  assert(python, 'Set NDM_SFTP_FIXTURE_PYTHON to the existing isolated Paramiko venv')
  const child = spawn(python, [resolve('scripts/qa-sftp-fixture.py'), '--bytes', '1048576', '--delay', '0'], { env: cleanProxyEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
  let metadata
  try {
    const metadataPath = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SFTP fixture readiness timed out')), 15000); let buffer = ''
      child.stdout.on('data', data => { buffer += String(data); if (!buffer.includes('\n')) return; clearTimeout(timer); try { resolve(JSON.parse(buffer.split('\n')[0]).metadataPath) } catch { reject(new Error('Invalid SFTP fixture readiness')) } })
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('SFTP fixture exited early')) })
    })
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    return { ...metadata, events: async () => (await readFile(join(metadata.root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      stop: async () => { await terminate(child, exited); await rm(metadata.root, { recursive: true, force: true }) } }
  } catch (error) { await terminate(child, exited); if (metadata?.root) await rm(metadata.root, { recursive: true, force: true }); throw error }
}
export function bencode(value) {
  if (Buffer.isBuffer(value) || typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]) }
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}
async function terminal(engine, gid, timeout = 12000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await engine.rpc('tellStatus', [gid])
    if (['complete', 'error', 'removed'].includes(last.status) || last.totalLength !== '0' && last.totalLength === last.completedLength) return last
    await delay(100)
  }
  throw new Error(`Fixture transfer timed out in ${last?.status ?? 'unknown'} state`)
}
export async function runAuxiliaryProxyQA(binary, python, { only = 'all' } = {}) {
  assert.ok(['all', 'sftp', 'bt'].includes(only), 'NDM_PROXY_QA_ONLY must be all, sftp or bt')
  const expected = 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343'
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expected, 'Use pinned macOS arm64 Aria2 Next 2.7.5')
  const root = await mkdtemp(join(tmpdir(), 'ndm-auxiliary-proxy-'))
  const cleanup = [], results = []
  const report = result => { results.push(result); console.log(JSON.stringify(result)) }
  const own = value => { cleanup.push(() => value.stop()); return value }
  try {
    const poison = own(await new LocalAuxiliaryProxy({ reject: true }).start())
    const poisoned = { ...process.env }
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy', 'SFTP_PROXY', 'sftp_proxy', 'ALL_PROXY', 'all_proxy']) poisoned[key] = poison.url()
    poisoned.NO_PROXY = '*'; poisoned.no_proxy = '*'
    if (only !== 'bt') {
      const sftp = own(await startReadOnlySFTPFixture(python))
      const proxyA = own(await new LocalAuxiliaryProxy({ ports: [sftp.port] }).start())
      const proxyB = own(await new LocalAuxiliaryProxy({ ports: [sftp.port] }).start())
      const reject = own(await new LocalAuxiliaryProxy({ reject: true }).start())
      let index = 0
      const scenario = async (name, { proxy, envProxy, optionProxy, remoteDNS = true, fail = false } = {}) => {
        const engine = await startAuxiliaryProxyEngine(binary, join(root, `sftp-${++index}`), { env: cleanProxyEnvironment(poisoned, envProxy) })
        const before = (await sftp.events()).length, routes = proxy?.routes.length ?? 0
        try {
          const uri = new URL(sftp.url); if (remoteDNS) uri.hostname = 'sftp.proxy-fixture.invalid'
          const options = { out: 'download.bin', 'sftp-user': sftp.username, 'sftp-passwd': sftp.password,
            'ssh-host-key-sha256': sftp.hostKeySHA256.slice(7) + '=', ...(optionProxy ? { 'all-proxy': optionProxy } : {}) }
          const gid = await engine.rpc('addUri', [[uri.href], options])
          const final = await terminal(engine, gid)
          if (fail) { assert.equal(final.status, 'error'); assert.equal(final.completedLength, '0'); assert.equal((await sftp.events()).slice(before).filter(event => event.event === 'connection').length, 0) }
          else { assert.equal(final.status, 'complete'); assert.equal(createHash('sha256').update(await readFile(join(engine.files, 'download.bin'))).digest('hex'), sftp.sha256) }
          const observed = proxy?.routes.slice(routes) ?? []
          if (proxy) { assert.ok(observed.length > 0); if (remoteDNS) assert.ok(observed.every(route => route.host === 'sftp.proxy-fixture.invalid')) }
          assert.equal(poison.accepted, 0, 'Inherited user proxy environment must be stripped')
          report({ name, passed: true, bytes: Number(final.completedLength), status: final.status, proxyRoutes: observed.map(({ kind, host, denied }) => ({ kind, remoteDNS: host === 'sftp.proxy-fixture.invalid', denied })), inheritedProxyConnections: poison.accepted })
        } finally { await engine.stop() }
      }
      await scenario('sftp-http-connect-option', { proxy: proxyA, optionProxy: proxyA.url() })
      await scenario('sftp-socks5h-environment', { proxy: proxyA, envProxy: proxyA.url('socks5h') })
      await scenario('sftp-socks5h-reject-no-direct', { proxy: reject, envProxy: reject.url('socks5h'), remoteDNS: false, fail: true })
      await scenario('sftp-http-reject-no-direct', { proxy: reject, optionProxy: reject.url(), remoteDNS: false, fail: true })
      const oldRoutes = proxyA.routes.length
      await scenario('sftp-switch-to-other-proxy', { proxy: proxyB, envProxy: proxyB.url('socks5h') })
      await scenario('sftp-proxy-off-clears-user-environment', { remoteDNS: false })
      assert.equal(proxyA.routes.length, oldRoutes, 'Switch/off cannot retain the previous proxy')
      const engine = await startAuxiliaryProxyEngine(binary, join(root, 'sftp-socks-option'), { env: cleanProxyEnvironment(poisoned) })
      try {
        let accepted = false, stored
        try { await engine.rpc('changeGlobalOption', [{ 'all-proxy': proxyA.url('socks5') }]); accepted = true; stored = (await engine.rpc('getGlobalOption'))['all-proxy'] } catch { /* Unsupported option must be reported, not silently treated as SOCKS. */ }
        assert.ok(!accepted || !String(stored).startsWith('socks5://'))
        report({ name: 'sftp-socks-option-is-not-supported', passed: true, accepted, preservedSOCKSScheme: false })
      } finally { await engine.stop() }
    }
    if (only !== 'sftp') {
      const payload = Buffer.alloc(1024 * 1024, 0x67), expectedPayload = createHash('sha256').update(payload).digest('hex')
      const info = { name: 'payload.bin', length: payload.length, 'piece length': 262144,
        pieces: Buffer.concat([0, 1, 2, 3].map(index => createHash('sha1').update(payload.subarray(index * 262144, (index + 1) * 262144)).digest())) }
      const seed = own(await startAuxiliaryProxyEngine(binary, join(root, 'bt-seed'), { env: cleanProxyEnvironment(poisoned) }))
      await writeFile(join(seed.files, 'payload.bin'), payload)
      const seedGID = await seed.rpc('addTorrent', [bencode({ info }).toString('base64'), [], { 'seed-ratio': '0', 'seed-time': '10' }])
      await terminal(seed, seedGID)
      let trackerRequests = 0
      const compactPeer = Buffer.from([127, 0, 0, 1, seed.btPort >> 8, seed.btPort & 255])
      const tracker = createHTTPServer((_req, response) => { trackerRequests++; const body = bencode({ interval: 60, complete: 1, incomplete: 0, peers: compactPeer }); response.writeHead(200, { 'content-length': body.length }); response.end(body) })
      tracker.listen(0, '127.0.0.1'); await once(tracker, 'listening')
      cleanup.push(() => new Promise(resolve => { tracker.closeAllConnections(); tracker.close(resolve) }))
      const trackerPort = tracker.address().port
      for (const scheme of ['http', 'socks4', 'socks5']) {
        const proxy = own(await new LocalAuxiliaryProxy({ ports: [trackerPort, seed.btPort] }).start())
        const engine = await startAuxiliaryProxyEngine(binary, join(root, `bt-${scheme}`), { env: cleanProxyEnvironment(poisoned) })
        try {
          assert.equal(await engine.rpc('changeGlobalOption', [{ 'bt-proxy': proxy.url(scheme) }]), 'OK')
          assert.equal((await engine.rpc('getGlobalOption'))['bt-proxy'], proxy.url(scheme))
          // Libtorrent SOCKS4 does not forward Tracker hostname resolution;
          // validate its IP transport without claiming SOCKS4a/remote DNS.
          const trackerHost = scheme === 'socks4' ? '127.0.0.1' : 'tracker.proxy-fixture.invalid'
          const torrent = bencode({ announce: `http://${trackerHost}:${trackerPort}/announce`, info })
          const gid = await engine.rpc('addTorrent', [torrent.toString('base64'), [], { 'seed-ratio': '0', 'seed-time': '10' }])
          assert.deepEqual(await engine.rpc('addBtPeers', [gid, [`127.0.0.1:${seed.btPort}`]]), { added: 1, failed: 0 })
          const final = await terminal(engine, gid, 15000)
          assert.equal(Number(final.completedLength), payload.length)
          assert.equal(createHash('sha256').update(await readFile(join(engine.files, 'payload.bin'))).digest('hex'), expectedPayload)
          for (let attempt = 0; attempt < 30 && !proxy.routes.some(route => route.port === trackerPort); attempt++) await delay(100)
          assert.ok(proxy.routes.some(route => route.port === seed.btPort && route.bytesDown >= payload.length), 'BT payload must traverse the selected proxy')
          assert.ok(proxy.routes.some(route => route.port === trackerPort && route.host === trackerHost), 'BT Tracker must traverse the selected proxy')
          assert.equal(poison.accepted, 0)
          report({ name: `bt-${scheme}-peer-and-tracker`, passed: true, bytes: payload.length, peerViaProxy: true, trackerViaProxy: true,
            trackerProxyDNS: scheme !== 'socks4', ...(scheme === 'socks4' ? { limitation: 'SOCKS4 Tracker requires local DNS or an IP' } : {}),
            trackerRequests, inheritedProxyConnections: poison.accepted })
        } finally { await engine.stop() }
      }
      const reject = own(await new LocalAuxiliaryProxy({ reject: true }).start())
      for (const scheme of ['http', 'socks5']) {
        const denied = await startAuxiliaryProxyEngine(binary, join(root, `bt-reject-${scheme}`), { env: cleanProxyEnvironment(poisoned) })
        const before = reject.routes.length
        try {
          await denied.rpc('changeGlobalOption', [{ 'bt-proxy': reject.url(scheme) }])
          const gid = await denied.rpc('addTorrent', [bencode({ info }).toString('base64'), [], {}])
          await denied.rpc('addBtPeers', [gid, [`127.0.0.1:${seed.btPort}`]])
          await delay(2200)
          assert.equal((await denied.rpc('tellStatus', [gid])).completedLength, '0')
          assert.ok(reject.routes.slice(before).some(route => route.port === seed.btPort && route.denied))
          report({ name: `bt-${scheme}-reject-no-direct`, passed: true, bytes: 0 })
        } finally { await denied.stop() }
      }
    }
    return results
  } finally {
    const failures = []
    for (const stop of cleanup.reverse()) try { await stop() } catch { failures.push('owned fixture shutdown failed') }
    await rm(root, { recursive: true, force: true })
    console.log(JSON.stringify({ cleanup: true, rootRemoved: true, failures }))
    assert.deepEqual(failures, [])
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runAuxiliaryProxyQA(resolve(process.argv[2] || 'native/Vendor/Tools/aria2-next'), process.env.NDM_SFTP_FIXTURE_PYTHON,
    { only: process.env.NDM_PROXY_QA_ONLY || 'all' })
}
