// Run with Electron after bundling src/main/urlContentType.ts to the argv[2] path.
// Real Chromium network stack, loopback servers, synthetic cookie only; no UI/profile access.
const { app } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { probeURLKind } = require(process.argv[2])
const root = mkdtempSync(join(tmpdir(), 'ndm-probe-wire-'))
app.setPath('userData', join(root, 'electron'))
const seen = []
let origin, target, streamBytes = 0, streamClosed = false
const makeServer = handler => createServer((req, res) => {
  seen.push({ server: req.socket.localPort, path: req.url, method: req.method, cookie: Boolean(req.headers.cookie) })
  handler(req, res)
})
const file = res => { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': '4' }); res.end('test') }
const redirect = (res, location) => { res.writeHead(302, { 'Content-Type': 'text/html', Location: location }); res.end('<a>redirect</a>') }
const destination = makeServer((_req, res) => file(res))
const source = makeServer((req, res) => {
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
    const report = {
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
    report.passed = Object.values(report).every(Boolean)
    console.log(JSON.stringify({ ...report, requests: seen })); if (!report.passed) code = 1
  } catch (error) { console.log(JSON.stringify({ passed: false, error: error.message, requests: seen })); code = 1 }
  finally {
    for (const server of [source, destination]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    rmSync(root, { recursive: true, force: true })
    app.exit(code)
  }
})()
