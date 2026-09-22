// Run with Electron after bundling src/main/urlContentType.ts to the argv[2] path.
// Real Chromium network stack, loopback servers, synthetic cookie only; no UI/profile access.
const { app } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { createServer: tcpServer, createConnection } = require('node:net')
const { probeURLKind, classifyURL } = require(process.argv[2])
const root = mkdtempSync(join(tmpdir(), 'ndm-probe-wire-'))
app.setPath('userData', join(root, 'electron'))
const seen = []
let host, hostExited, sequence = 0
let origin, target, streamBytes = 0, streamClosed = false
const makeServer = handler => createServer((req, res) => {
  seen.push({ server: req.socket.localPort, path: req.url, method: req.method, cookie: Boolean(req.headers.cookie), sourceHeaders: req.headers.referer === origin + '/source-page' && req.headers['x-ndm-fixture'] === 'preserve' })
  handler(req, res)
})
const file = res => { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': '4' }); res.end('test') }
const redirect = (res, location) => { res.writeHead(302, { 'Content-Type': 'text/html', Location: location }); res.end('<a>redirect</a>') }
const destination = makeServer((_req, res) => file(res))
const source = makeServer((req, res) => {
  if (req.url === '/login.zip') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '7' }); res.end('sign in'); return }
  if (req.url === '/auth-cross') {
    if (req.headers.cookie === 'ndm_probe_fixture=1') return redirect(res, target + '/file')
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('sign in'); return
  }
  if (req.url === '/hang') return
  if (req.url === '/stream') {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(8 * 1024 * 1024) }); res.flushHeaders()
    const timer = setInterval(() => { streamBytes += 16384; res.write(Buffer.alloc(16384)); if (streamBytes >= 8 * 1024 * 1024) { clearInterval(timer); res.end() } }, 5)
    res.on('close', () => { streamClosed = true; clearInterval(timer) })
    return
  }
  if (req.url === '/file') return file(res)
  if (req.url === '/cross') return redirect(res, target + '/file')
  if (req.url === '/unknown') {
    if (req.method === 'HEAD') res.writeHead(200, { 'Content-Type': 'application/x-fixture-unknown' })
    else res.writeHead(302, { Location: '/file' })
    res.end(); return
  }
  if (req.url === '/get-start' && req.method === 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/html' }); res.end(); return }
  if (req.url?.startsWith('/chain/')) {
    const hop = Number(req.url.split('/').pop())
    return hop < 7 ? redirect(res, `/chain/${hop + 1}`) : file(res)
  }
  return redirect(res, '/file')
})
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
;(async () => {
  let code = 0
  try {
    await app.whenReady()
    await listen(source); await listen(destination)
    origin = `http://127.0.0.1:${source.address().port}`
    target = `http://127.0.0.1:${destination.address().port}`
    const same = await probeURLKind({ url: origin + '/redirect', method: 'HEAD', cookieHeader: 'ndm_probe_fixture=1' })
    const getOnly = await probeURLKind({ url: origin + '/get-start', method: 'HEAD' })
    const unknown = await probeURLKind({ url: origin + '/unknown', method: 'HEAD' })
    const cross = await probeURLKind({ url: origin + '/cross', method: 'HEAD', cookieHeader: 'ndm_probe_fixture=1' })
    const chain = await probeURLKind({ url: origin + '/chain/0', method: 'HEAD' })
    const stream = await probeURLKind({ url: origin + '/stream', method: 'HEAD' })
    const started = Date.now()
    const timeoutRejected = await probeURLKind({ url: origin + '/hang', method: 'HEAD', timeoutMs: 40 }).then(() => false, () => true)
    const timeoutBounded = timeoutRejected && Date.now() - started < 2000
    for (let i = 0; i < 50 && !streamClosed; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const authenticated = await classifyURL(origin + '/auth-cross', async () => 'ndm_probe_fixture=1')
    const report = {
      sourceSessionBound: authenticated.kind === 'binary' && authenticated.cookieUsed === undefined && authenticated.sourceCookie?.url === origin + '/auth-cross' && authenticated.sourceCookie?.header === 'ndm_probe_fixture=1',
      ignoredRangeBodyStopped: stream.kind === 'binary' && streamClosed && streamBytes <= 65536,
      timeoutBounded,
      sameOriginFile: same.kind === 'binary',
      sameOriginCookieRetained: seen.some(row => row.server === source.address().port && row.path === '/file' && row.cookie),
      refusedHeadRedirectFile: getOnly.kind === 'binary',
      untypedGetRedirectFile: unknown.kind === 'binary',
      crossOriginFile: cross.kind === 'binary',
      crossOriginCookieAbsent: seen.filter(row => row.server === destination.address().port).every(row => !row.cookie),
      crossOriginCookieMetadataCleared: cross.cookieUsed === undefined,
      hopLimitEnforced: seen.filter(row => row.path.startsWith('/chain/')).length === 5 && chain.kind === 'unknown'
    }
    if (process.argv[3]) {
      const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
      const port = await freePort(), bridge = await freePort(), support = join(root, 'support'), downloads = join(root, 'downloads')
      mkdirSync(support); mkdirSync(downloads)
      host = spawn(process.argv[3], [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
      hostExited = once(host, 'exit')
      const rpc = (op, extra = {}) => new Promise((resolve, reject) => {
        const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port }); let buffer = ''
        socket.setTimeout(4000, () => socket.destroy(new Error('fixture RPC timeout')))
        socket.on('error', reject)
        socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...extra }) + '\n'))
        socket.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\n')) >= 0;) {
          const reply = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
          if (reply.id === id) { socket.destroy(); resolve(reply); return }
        } })
      })
      const until = async predicate => { for (let i = 0; i < 200; i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('fixture host timeout') }
      await until(async () => { try { return (await rpc('ping')).ok } catch { return false } })
      if (process.argv[4]) {
        const loginURL = origin + '/login.zip'
        const loginClassification = await classifyURL(loginURL)
        globalThis.window = { ndm: { classifyURL: async () => loginClassification, request: async (op, fields) => op === 'probeMedia' ? { ok: true, formats: [] } : rpc(op, fields) } }
        const { addFromUrl } = require(process.argv[4])
        let rejected = false
        try { await addFromUrl({ url: loginURL, folderPath: downloads }) } catch (error) { rejected = error.message.includes('网页') }
        report.htmlFileRejected = rejected
        report.htmlCreatedNoTask = (await rpc('list')).tasks.length === 0
      }
      const boundary = seen.length
      if (process.argv[4]) {
        globalThis.window = { ndm: { classifyURL: async () => ({ ...authenticated, cookieBrowser: 'chrome:Fixture' }), request: rpc } }
        const { addFromUrl } = require(process.argv[4])
        await addFromUrl({ url: authenticated.sourceCookie.url, headers: ['Referer: ' + origin + '/source-page', 'X-NDM-Fixture: preserve'], filename: 'authenticated.bin', folderPath: downloads })
      } else {
        const added = await rpc('add', { url: authenticated.sourceCookie.url, headers: ['Cookie: ' + authenticated.sourceCookie.header], filename: 'authenticated.bin', folderPath: downloads })
        if (!added.ok) throw new Error('fixture add failed')
      }
      const delivered = await until(async () => (await rpc('list')).tasks.find(task => task.status === 'complete'))
      const transfers = seen.slice(boundary)
      if (process.argv[4]) report.creationHeadersPreserved = transfers.some(row => row.path === '/auth-cross' && row.sourceHeaders)
      report.nativeSourceSession = transfers.some(row => row.path === '/auth-cross' && row.cookie)
      report.nativeCDNAnonymous = transfers.some(row => row.server === destination.address().port && row.method === 'GET') && transfers.filter(row => row.server === destination.address().port).every(row => !row.cookie)
      report.nativeExactArtifact = readFileSync(join(delivered.folderPath, delivered.filename)).equals(Buffer.from('test'))
    }
    report.passed = Object.values(report).every(Boolean)
    console.log(JSON.stringify({ ...report, requests: seen })); if (!report.passed) code = 1
  } catch (error) { console.log(JSON.stringify({ passed: false, error: error.message, requests: seen })); code = 1 }
  finally {
    if (host && host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await hostExited }
    for (const server of [source, destination]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (host) {
      let hash = 0xcbf29ce484222325n
      for (const byte of Buffer.from(join(root, 'support'))) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
      try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch {}
    }
    rmSync(root, { recursive: true, force: true })
    app.exit(code)
  }
})()
