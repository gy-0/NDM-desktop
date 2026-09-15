// Real isolated Host + synthetic legacy Relay WebSocket. No renderer, browser,
// public network, copied user state, or playback claim. Pass the NEW Host path;
// deliberately no default binary, so a stale local build is never used by accident.
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer as createHTTPServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const fail = code => { throw new Error(code) }
const check = (condition, code) => { if (!condition) fail(code) }
const hash = data => createHash('sha256').update(data).digest('hex')
const binaryArgument = process.argv[2]
if (!binaryArgument) {
  console.error('Usage: node scripts/qa-relay-captured-route.mjs /absolute/path/to/new/NDMHost')
  process.exitCode = 2
} else {
  await main()
}

async function main() {
  const binary = resolve(binaryArgument)
  const report = { passed: false, boundary: 'isolated real Host, synthetic legacy Relay, authenticated loopback bytes; no UI or playback verification',
    checks: {}, requests: { captured: 0, authorized: 0, denied: 0, unexpectedPage: 0, unknown: 0 }, cleanup: {} }
  let root, support, host, hostExited, fixture, bridge, engine, hostPort, bridgePort
  const ownedSockets = new Set(), fixtureSockets = new Set()
  let hostLaunchFailed = false, cleanupTask, cancelled = false
  const cancel = () => { cancelled = true; void cleanup() }
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)

  async function until(code, predicate, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (cancelled) fail('interrupted')
      const value = await predicate()
      if (value) return value
      if (hostLaunchFailed || host && (host.exitCode !== null || host.signalCode !== null)) fail('hostExitedEarly')
      await delay(50)
    }
    fail(code)
  }
  async function freePort(excluded = []) {
    const server = createTCPServer()
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const port = server.address().port
    await new Promise(done => server.close(done))
    return [51873, 51874, 10007, ...excluded].includes(port) ? freePort(excluded) : port
  }
  async function connectEngine() {
    const socket = createConnection({ host: '127.0.0.1', port: hostPort })
    ownedSockets.add(socket); socket.once('close', () => ownedSockets.delete(socket))
    const pending = new Map(), events = []
    let sequence = 0, input = ''
    socket.setEncoding('utf8')
    socket.on('error', () => { for (const entry of pending.values()) entry.finish(null); pending.clear() })
    socket.on('close', () => { for (const entry of pending.values()) entry.finish(null); pending.clear() })
    socket.on('data', chunk => {
      input += chunk
      if (input.length > 4 * 1024 * 1024) { socket.destroy(); return }
      while (input.includes('\n')) {
        const boundary = input.indexOf('\n'), line = input.slice(0, boundary); input = input.slice(boundary + 1)
        let value
        try { value = JSON.parse(line) } catch { continue }
        if (value.op === 'openMediaComposer') events.push({ op: value.op, url: value.url })
        const entry = pending.get(value.id)
        if (entry) { pending.delete(value.id); entry.finish(value) }
      }
    })
    const connected = await new Promise(done => {
      const timer = setTimeout(() => { socket.destroy(); done(false) }, 500)
      socket.once('connect', () => { clearTimeout(timer); done(true) })
      socket.once('error', () => { clearTimeout(timer); socket.destroy(); done(false) })
    })
    if (!connected) return null
    return { events, socket, request(op, extra = {}) {
      return new Promise(done => {
        if (socket.destroyed) { done(null); return }
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); done(null) }, 5000)
        pending.set(id, { finish(value) { clearTimeout(timer); done(value) } })
        socket.write(JSON.stringify({ id, op, ...extra }) + '\n')
      })
    } }
  }
  async function closeBridge() {
    if (!bridge || bridge.readyState === WebSocket.CLOSED) return
    await new Promise(done => {
      const timer = setTimeout(done, 1500)
      bridge.addEventListener('close', () => { clearTimeout(timer); done() }, { once: true })
      try { bridge.close() } catch { clearTimeout(timer); done() }
    })
  }
  function cleanup() {
    return cleanupTask ||= (async () => {
    await closeBridge()
    for (const socket of ownedSockets) socket.destroy()
    if (host && host.exitCode === null && host.signalCode === null) {
      host.kill('SIGTERM')
      const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
      await hostExited; clearTimeout(timer)
    }
    await closeBridge()
    report.cleanup.hostExited = !host || host.exitCode !== null || host.signalCode !== null || hostLaunchFailed
    if (fixture) {
      for (const socket of fixtureSockets) socket.destroy()
      fixture.closeAllConnections?.()
      if (fixture.listening) await new Promise(done => fixture.close(done))
    }
    report.cleanup.fixtureClosed = !fixture?.listening
    report.cleanup.bridgeClosed = !bridge || bridge.readyState === WebSocket.CLOSED
    report.cleanup.engineConnectionsClosed = [...ownedSockets].every(socket => socket.destroyed)
    if (support) {
      let value = 0xcbf29ce484222325n
      for (const byte of Buffer.from(support)) value = ((value ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
      // Only this generated support path's settings domain. Never the app's
      // ordinary preferences, browser settings, or another QA session.
      try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${value.toString(16)}`], { stdio: 'ignore' }) } catch { /* Missing domain is already clean. */ }
    }
    if (root) {
      await rm(root, { recursive: true, force: true })
      report.cleanup.rootRemoved = await access(root).then(() => false, () => true)
    } else report.cleanup.rootRemoved = true
    })()
  }
  try {
    check(typeof WebSocket === 'function', 'nodeWebSocketUnavailable')
    await access(binary, constants.X_OK)
    report.hostSHA256 = hash(await readFile(binary))
    root = await mkdtemp(join(tmpdir(), 'ndm-relay-captured-route-'))
    support = join(root, 'support')
    const downloads = join(root, 'downloads'), emptyTools = join(root, 'tools')
    await Promise.all([support, downloads, emptyTools].map(path => mkdir(path)))
    hostPort = await freePort(); bridgePort = await freePort([hostPort])

    const payload = Buffer.alloc(192 * 1024)
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 17) % 251
    const token = 'qa-captured-route-synthetic-only'
    const exactPath = `/captured?signature=${token}`
    let expectedHeaders
    fixture = createHTTPServer((request, response) => {
      if (request.url === '/watch-explicit' || request.url === '/watch-unknown') {
        report.requests.unexpectedPage++
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(request.method === 'HEAD' ? undefined : '<!doctype html><title>Synthetic page</title>'); return
      }
      if (request.url !== exactPath) { report.requests.unknown++; response.writeHead(404); response.end(); return }
      report.requests.captured++
      const authorized = Object.entries(expectedHeaders).every(([name, value]) => request.headers[name] === value)
      if (!authorized) { report.requests.denied++; response.writeHead(403); response.end(); return }
      report.requests.authorized++
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const end = Math.min(range?.[2] ? Number(range[2]) : payload.length - 1, payload.length - 1)
      if (start > end || !Number.isSafeInteger(start)) { response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` }); response.end(); return }
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', 'ETag': '"ndm-relay-captured-fixture"',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
      response.end(request.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
    })
    fixture.on('connection', socket => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)) })
    await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', done) })
    const origin = `http://127.0.0.1:${fixture.address().port}`
    const pageURL = `${origin}/source-page`, capturedURL = origin + exactPath
    expectedHeaders = { cookie: `ndm_qa=${token}`, referer: pageURL, origin, 'user-agent': 'NDM-Relay-Captured-Route-QA/1', 'x-qa': token }

    // No inherited proxies, loader variables, browser paths, or user tool
    // locations. Empty NDM_TOOL_DIR also prevents media extraction in this QA.
    host = spawn(binary, [], { cwd: root, stdio: 'ignore', env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: root,
      NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: emptyTools,
      NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
    } })
    hostExited = new Promise(done => { host.once('exit', done); host.once('error', () => { hostLaunchFailed = true; done() }) })
    engine = await until('hostStartupTimeout', connectEngine)
    check((await engine.request('ping'))?.ok, 'hostPingFailed')
    check((await engine.request('updateSettings', { downloadDirectory: downloads, useCategoryFolders: false,
      askBrowserDownloadDestination: false, maxConnections: 2, bandwidthLimitBytesPerSecond: 0 }))?.ok, 'settingsFailed')
    check((await engine.request('list'))?.tasks?.length === 0, 'initialLibraryNotEmpty')
    await until('bridgeStartupTimeout', async () => {
      const value = (await engine.request('getBridgeStatus'))?.bridge
      return value?.available && value.port === bridgePort
    })
    bridge = new WebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, 'ndm.open.v1')
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('bridgeHandshakeTimeout')), 5000)
      bridge.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
      bridge.addEventListener('error', () => { clearTimeout(timer); reject(new Error('bridgeHandshakeFailed')) }, { once: true })
    })
    bridge.send(['1:GET', `2:${capturedURL}`, '4:Synthetic captured media', `5:${pageURL}`, '6:media',
      `7:${payload.length}`, '8:video/mp4', `9:${expectedHeaders['user-agent']}`, `Cookie: ${expectedHeaders.cookie}`,
      `Referer: ${expectedHeaders.referer}`, `Origin: ${expectedHeaders.origin}`, `X-QA: ${expectedHeaders['x-qa']}`, ''].join('\r\n'))
    const task = await until('capturedDownloadTimeout', async () => {
      check(!engine.events.some(event => event.url === capturedURL), 'capturedURLWasOpenedInComposer')
      const tasks = (await engine.request('list'))?.tasks ?? []
      check(tasks.length <= 1, 'duplicateCapturedTasks')
      const task = tasks.find(task => task.url === capturedURL)
      check(task?.status !== 'error', 'capturedTaskFailed')
      return task?.status === 'complete' ? task : false
    }, 20000)
    check(task.pageURL === pageURL, 'snapshotPageURLNotRetained')
    check(task.linkType !== 'ytdlp', 'capturedTaskEnteredPageExtractor')
    const destination = resolve(task.folderPath, task.filename)
    check(destination.startsWith(downloads + sep), 'destinationEscapedFixture')
    const downloaded = await readFile(destination)
    check(downloaded.equals(payload), 'downloadedBytesMismatch')
    check(report.requests.authorized > 0 && report.requests.denied === 0, 'requestHeadersNotRetained')
    check(Number.isSafeInteger(task.id) && task.id > 0, 'invalidTaskID')
    // Read only this fixture's database. Header values remain in memory for
    // comparison and never appear in output, errors, filenames, or logs.
    const database = join(support, 'NeatDB.db')
    const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', database,
      `SELECT pageurl, useragent FROM downloads WHERE id=${task.id};`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const storedHeaders = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', database,
      `SELECT header FROM headers WHERE id=${task.id};`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const map = new Map(storedHeaders.map(row => { const split = row.header.indexOf(':'); return [row.header.slice(0, split).toLowerCase(), row.header.slice(split + 1).trim()] }))
    check(rows.length === 1 && rows[0].pageurl === pageURL, 'storedPageURLNotRetained')
    check(rows[0].useragent === expectedHeaders['user-agent'], 'storedUserAgentNotRetained')
    check(['cookie', 'referer', 'origin', 'x-qa'].every(name => map.get(name) === expectedHeaders[name]), 'storedHeadersNotRetained')
    report.checks.capturedRouteSkippedComposer = true
    report.checks.storedPageURLRetained = true
    report.checks.storedUserAgentRetained = true
    report.checks.storedHeaderNames = [...map.keys()].sort()
    report.checks.exactAuthenticatedBytes = true
    report.bytes = downloaded.length; report.sha256 = hash(downloaded)

    for (const [path, type, mime] of [['/watch-explicit', 'media-page', 'video/mp4'], ['/watch-unknown', 'media', 'text/html']]) {
      const target = origin + path
      bridge.send(['1:GET', `2:${target}`, `5:${pageURL}`, `6:${type}`, `8:${mime}`, ''].join('\r\n'))
      await until('pageComposerEventTimeout', async () => engine.events.some(event => event.url === target))
      await delay(200)
      check((await engine.request('list'))?.tasks?.length === 1, 'pageMessageCreatedTask')
    }
    check(engine.events.length === 2, 'unexpectedComposerEventCount')
    check(report.requests.unexpectedPage === 0 && report.requests.unknown === 0, 'pageMessageStartedNetworkRequest')
    report.checks.explicitMediaPageWinsOverVideoMIME = true
    report.checks.unknownHTMLStillOpensComposer = true
    report.checks.pageMessagesCreatedZeroTasks = true
    report.checks.composerEvents = engine.events.length
    report.checks.taskCount = 1
    report.passed = true
  } catch (error) {
    // Do not print assertion operands, command stdout, raw Host errors, URLs,
    // query strings, or authentication material, including synthetic values.
    report.failure = /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error?.message ?? '') ? error.message : 'fixtureExecutionFailed'
    process.exitCode = 1
  } finally {
    try { await cleanup() } catch { report.cleanup.failed = true; report.passed = false; process.exitCode = 1 }
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    if (Object.values(report.cleanup).some(value => value !== true)) { report.passed = false; process.exitCode = 1 }
    console.log(JSON.stringify(report))
  }
}
