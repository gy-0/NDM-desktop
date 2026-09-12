// Real Chromium extension → isolated Swift host file-click QA.
// Run from the repository root after build:native. NDM_QA_HOST_PATH selects an
// independently built host; NDM_QA_EXTENSION_SOURCE selects a frozen extension.
// NDM_QA_BROWSER_PATH overrides the Playwright browser executable.
// NDM_QA_CASE selects comma-separated scenarios; NDM_QA_OUTPUT_DIR stores traces.
// NDM_QA_RECORD_ONLY=1 observes a historical extension without new-path assertions.
// NDM_QA_EXPECT_LEGACY_HOST=1 proves actual missing-capability fallback behavior.
// Only synthetic local files/credentials are used. Never point at a live profile.
import assert from 'node:assert/strict'
import { createBridgeFaultProxy } from './qa-relay-file-clicks-proxy.mjs'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve('.')
const expectLegacyHost = process.env.NDM_QA_EXPECT_LEGACY_HOST === '1'
const extensionSource = resolve(process.env.NDM_QA_EXTENSION_SOURCE || 'extension/NDMRelay')
const evidence = resolve(process.env.NDM_QA_OUTPUT_DIR || 'outputs/relay-zero-native/after')
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/release/NDMHost')
const executablePath = process.env.NDM_QA_BROWSER_PATH || chromium.executablePath()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const payload = Buffer.alloc(2 * 1024 * 1024)
for (let i = 0; i < payload.length; i++) payload[i] = i % 251
mkdirSync(evidence, { recursive: true })
async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  if ([51873, 51874, 10007].includes(port)) return freePort()
  return port
}
async function portTaken(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); done(true) })
    socket.once('error', () => done(false))
  })
}
async function until(fn, label, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(50) }
  throw new Error(label)
}
class HostClient {
  constructor(port, record) { this.port = port; this.record = record; this.pending = new Map(); this.nextID = 0; this.buffer = ''; this.seen = new Map() }
  async connect() {
    this.socket = createConnection({ host: '127.0.0.1', port: this.port })
    this.socket.setEncoding('utf8')
    this.socket.on('data', chunk => {
      this.buffer += chunk
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let data; try { data = JSON.parse(line) } catch { continue }
        if (data.op === 'snapshot') for (const task of data.tasks || []) {
          if (this.seen.get(task.id) === task.status) continue
          this.seen.set(task.id, task.status)
          this.record('host:task', { taskID: task.id, status: task.status, filename: task.filename, bytes: task.completedBytes })
        }
        if (data.op === 'focusApp') this.record('host:focus', {})
        const pending = this.pending.get(data.id)
        if (pending) { this.pending.delete(data.id); clearTimeout(pending.timer); data.ok === false ? pending.reject(new Error(data.error)) : pending.resolve(data) }
      }
    })
    await new Promise((done, reject) => { this.socket.once('connect', done); this.socket.once('error', reject) })
  }
  request(op, fields = {}) {
    const id = ++this.nextID
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Host RPC timeout: ' + op)) }, 10_000)
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, op, ...fields }) + '\n')
    })
  }
  close() { this.socket?.destroy(); for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host closed')) }; this.pending.clear() }
}
function preferencesSuite(support) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return 'ndm.support.' + hash.toString(16)
}
function readPreferences(suite) {
  const result = spawnSync('/usr/bin/defaults', ['export', suite, '-'], { encoding: 'utf8' })
  if (result.status === 0) return /<dict\s*\/>|<dict>\s*<\/dict>/.test(result.stdout) ? null : result.stdout
  if (/does not exist|not found/i.test(result.stderr + result.stdout)) return null
  throw new Error('Cannot inspect exact QA preferences suite')
}
async function runCase(scenario) {
  const root = mkdtempSync('/tmp/ndm-zero-native-'), support = join(root, 'support'), downloads = join(root, 'downloads')
  for (const directory of [support, downloads]) mkdirSync(directory, { recursive: true })
  const port = await freePort(); let bridge = await freePort(); while (bridge === port) bridge = await freePort()
  const suite = preferencesSuite(support), plist = join(homedir(), 'Library/Preferences', suite + '.plist')
  assert.equal(readPreferences(suite), null); assert.equal(existsSync(plist), false)
  let extensionBridge = bridge
  const events = [], record = (kind, details = {}) => events.push({ time: Date.now(), kind, ...details })
  const report = { harnessSHA256: sha256(readFileSync(new URL(import.meta.url))), proxySHA256: sha256(readFileSync(new URL('./qa-relay-file-clicks-proxy.mjs', import.meta.url))), name: scenario.name, online: scenario.online, root, hostPort: port, bridgePort: bridge, preferencesSuite: suite, events, sourceSHA256: sha256(payload), extensionSHA256: Object.fromEntries(readdirSync(extensionSource).filter(file => /\.(?:js|css|html)$/.test(file) || file === 'manifest.json').sort().map(file => [file, sha256(readFileSync(join(extensionSource, file)))])), hostSHA256: sha256(readFileSync(hostPath)) }
  const cookie = 'relay_fixture_session=local-only-' + scenario.name
  let sourceURL, targetURL, server, processHost, browser, worker, host, proxy, sink
  const cleanupFailures = []
  try {
    if (scenario.crossRedirect) {
      sink = createServer((req, res) => {
        record('http:cross-origin-sink', { method: req.method, cookiePresent: Boolean(req.headers.cookie), authorizationPresent: Boolean(req.headers.authorization), refererPresent: Boolean(req.headers.referer), refererContainsSyntheticPageToken: Boolean(req.headers.referer?.includes('fixture-private-token')), refererOriginOnly: req.headers.referer === new URL(sourceURL).origin + '/' })
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1
        const body = payload.subarray(start, Math.min(end + 1, payload.length))
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${scenario.name}.zip"`, 'Accept-Ranges': 'bytes', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {}) })
        res.end(req.method === 'HEAD' ? undefined : body)
      })
      await new Promise(done => sink.listen(0, 'localhost', done))
    }
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return }
      if (url.pathname === '/page.html') {
        if (scenario.authHeader && req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:synthetic-fixture-secret').toString('base64')) { record('http:page-auth-challenge'); res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic-relay-qa"', 'Content-Length': '0' }).end(); return }
        record('http:page-success', { authorizationPresent: Boolean(req.headers.authorization) })
        const target = (scenario.redirect ? '/redirect/' : '/payload/') + scenario.name + '.zip' + (scenario.query ? '?token=fixture-only' : '')
        const html = `<!doctype html><meta charset="utf-8"><title>Relay ordinary link QA</title>${scenario.metaPolicies ? '<meta name="referrer" content="same-origin"><meta name="referrer" content="no-referrer">' : ''}${scenario.metaRemoved ? '<script>const m=document.createElement("meta");m.name="referrer";m.content="no-referrer";document.head.append(m);m.remove();</script>' : ''}<style>body{font:18px system-ui;margin:60px}a{padding:18px;display:inline-block}</style><h1>Relay ${scenario.name}</h1><a id="target" href="${target}" ${scenario.download ? 'download="download-attribute.zip"' : ''} ${scenario.noreferrer ? 'rel="noreferrer"' : ''} ${scenario.noReferrer ? 'referrerpolicy="no-referrer"' : ''} ${scenario.targetBlank ? 'target="_blank"' : ''}>Download file</a>${scenario.handled ? '<script>document.querySelector("#target").addEventListener("click",event=>{event.preventDefault();document.title="Website owns click";})</script>' : ''}`
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html), 'Set-Cookie': cookie + '; Path=/; HttpOnly; SameSite=Lax', 'Cache-Control': 'no-store', ...(scenario.headerPolicies ? { 'Referrer-Policy': ['same-origin', 'no-referrer'] } : {}) }).end(html)
        return
      }
      if (scenario.headTimeout && req.method === 'HEAD') { record('http:head-delayed', { path: url.pathname }); const timer = setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payload.length }).end(), 3_000); res.on('close', () => clearTimeout(timer)); return }
      if (scenario.head405 && req.method === 'HEAD') { record('http:head-rejected', { path: url.pathname }); res.writeHead(405, { 'Content-Length': '0' }).end(); return }
      if (scenario.html) { record('http:html', { path: url.pathname, method: req.method }); const html = '<!doctype html><title>Safe original HTML navigation</title><h1>Original website navigation works</h1>'; res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) }); res.end(req.method === 'HEAD' ? undefined : html); return }
      const authenticated = req.headers.cookie?.includes(cookie) && req.headers.referer === sourceURL.split('#')[0] && (!scenario.authHeader || req.headers.authorization === 'Basic ' + Buffer.from('fixture-user:synthetic-fixture-secret').toString('base64'))
      record('http:request', { path: url.pathname, method: req.method, range: req.headers.range || null, browserFetchMode: req.headers['sec-fetch-mode'] || null, authenticated: Boolean(authenticated), refererHasFragment: Boolean(req.headers.referer?.includes('#')),  ...(scenario.crossRedirect || scenario.authHeader ? { cookiePresent: Boolean(req.headers.cookie), authorizationPresent: Boolean(req.headers.authorization), refererPresent: Boolean(req.headers.referer), refererContainsSyntheticPageToken: Boolean(req.headers.referer?.includes('fixture-private-token')) } : {}) })
      if (scenario.auth && !authenticated) { res.writeHead(403, { 'Content-Length': '0' }).end(); return }
      if (url.pathname.startsWith('/redirect/')) { res.writeHead(302, { Location: scenario.crossRedirect ? `http://localhost:${sink.address().port}/sink.zip` : '/payload/' + scenario.name + '.zip' }).end(); return }
      if (!url.pathname.startsWith('/payload/')) { res.writeHead(404).end(); return }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1
      const body = payload.subarray(start, Math.min(end + 1, payload.length))
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${scenario.name}.zip"`, 'Accept-Ranges': 'bytes', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {}) })
      if (req.method === 'HEAD') { res.end(); return }
      let offset = 0, timer
      const send = () => {
        if (res.destroyed || res.writableEnded) return
        if (offset === body.length) { res.end(); return }
        const next = Math.min(offset + 128 * 1024, body.length)
        res.write(body.subarray(offset, next)); offset = next; timer = setTimeout(send, 70)
      }
      res.on('close', () => clearTimeout(timer)); send()
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    sourceURL = `http://127.0.0.1:${server.address().port}/page.html` + (scenario.crossRedirect ? '?private=fixture-private-token' : '') + (scenario.pageHash ? '#/route?token=fixture-only-hash' : '')
    targetURL = `http://127.0.0.1:${server.address().port}/payload/${scenario.name}.zip` + (scenario.query ? '?token=fixture-only' : '')
    if (scenario.online) {
      assert.equal(await portTaken(port), false); assert.equal(await portTaken(bridge), false)
      processHost = spawn(hostPath, [], { cwd: repository, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1', NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: join(repository, 'native/Vendor/Tools') } })
      await until(() => portTaken(port), 'Host failed to start')
      host = new HostClient(port, record); await host.connect()
      assert.deepEqual((await host.request('list')).tasks, [])
      assert.equal((await host.request('updateSettings', { downloadDirectory: downloads, maxConnections: 32 })).ok, true)
    }
    if (scenario.lostAck || scenario.rejectFirst) { proxy = await createBridgeFaultProxy(bridge, record, scenario.rejectFirst ? 'reject-first' : 'drop-ack'); extensionBridge = proxy.port; report.proxyPort = extensionBridge }
    const extension = join(root, 'extension'); cpSync(extensionSource, extension, { recursive: true })
    for (const file of ['bg.js', 'popup.js']) writeFileSync(join(extension, file), readFileSync(join(extension, file), 'utf8').replaceAll('ws://127.0.0.1:51873/ndm/download', `ws://127.0.0.1:${extensionBridge}/ndm/download`).replaceAll('ws://127.0.0.1:10007/ndm/download', `ws://127.0.0.1:${extensionBridge}/ndm/download`))
    browser = await chromium.launchPersistentContext(join(root, 'profile'), { executablePath, channel: 'chromium', headless: true, acceptDownloads: true, ...(scenario.authHeader ? { httpCredentials: { username: 'fixture-user', password: 'synthetic-fixture-secret' } } : {}), downloadsPath: join(root, 'browser-downloads'), args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
    worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker')
    await until(() => worker.evaluate(online => NDM_BG.settingsReady && NDM_BG.v && Boolean(NDM_BG.D) === online, scenario.online), 'Worker readiness mismatch')
    const observeWorker = async () => worker.evaluate(() => {
      globalThis.__events = []
      const record = (kind, details = {}) => __events.push({ time: Date.now(), kind, ...details })
      chrome.downloads.onCreated.addListener(item => record('chrome:created', { id: item.id, url: item.url, finalUrl: item.finalUrl, state: item.state, paused: item.paused }))
      chrome.downloads.onChanged.addListener(change => record('chrome:changed', change))
      chrome.downloads.onErased.addListener(id => record('chrome:erased', { id }))
      chrome.webRequest.onBeforeRequest.addListener(item => record('chrome:request', { id: item.requestId, type: item.type, url: item.url, method: item.method }), { urls: ['http://127.0.0.1/*'] })
      chrome.webRequest.onHeadersReceived.addListener(item => record('chrome:headers', { id: item.requestId, type: item.type, url: item.url, status: item.statusCode, wwwAuthenticatePresent: (item.responseHeaders || []).some(header => header.name.toLowerCase() === 'www-authenticate') }), { urls: ['http://127.0.0.1/*', 'http://localhost/*'] }, ['responseHeaders', 'extraHeaders'])
      chrome.webRequest.onBeforeSendHeaders.addListener(item => record('chrome:auth-header-visibility', { id: item.requestId, url: item.url, authorizationPresent: (item.requestHeaders || []).some(header => header.name.toLowerCase() === 'authorization') }), { urls: ['http://127.0.0.1/*', 'http://localhost/*'] }, ['requestHeaders', 'extraHeaders'])
      if (typeof NDM_BG.handleFileClick === 'function') {
        const handle = NDM_BG.handleFileClick
        NDM_BG.handleFileClick = function(port, request) { record('worker:early-intent', { requestID: request.requestId }); return handle.call(this, port, request) }
      }
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function(message) {
        if (String(message).startsWith('NDMRelayDownload:')) { const value = JSON.parse(message.slice('NDMRelayDownload:'.length)); record('bridge:download-send', { requestID: value.requestId }) }
        else if (/^[123]:/.test(String(message))) record('bridge:legacy-send')
        else if (String(message).startsWith('NDMControl:')) record('bridge:focus-send')
        return send.call(this, message)
      }
      NDM_BG.G.addEventListener('message', event => {
        if (String(event.data).startsWith('NDMRelayReceipt:')) record('bridge:receipt', JSON.parse(event.data.slice('NDMRelayReceipt:'.length)))
      })
    })
    await observeWorker()
    const page = await browser.newPage()
    await page.exposeBinding('__qaRecordClick', (_, event) => events.push(event))
    await page.addInitScript(() => {
      window.__clicks = []
      addEventListener('click', event => { const link = event.target.closest?.('a'); if (link) window.__qaRecordClick({ time: Date.now(), kind: 'page:click', trusted: event.isTrusted, href: link.href, download: link.hasAttribute('download'), detail: event.detail }) }, true)
    })
    await page.goto(sourceURL)
    if (scenario.authWorkerRestart) {
      await until(() => worker.evaluate(async url => {
        const stored = await chrome.storage.session.get('ndmClickHTTPAuthOriginsV1')
        return stored.ndmClickHTTPAuthOriginsV1?.includes(new URL(url).origin)
      }, sourceURL), 'Known-auth origin must be persisted before restart QA')
      const inspector = await browser.newCDPSession(page), versions = new Map()
      inspector.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) { versions.set(version.versionId, version); record('cdp:worker-lifecycle', { versionId: version.versionId, runningStatus: version.runningStatus }) } })
      await inspector.send('ServiceWorker.enable')
      const version = await until(() => [...versions.values()].find(item => item.scriptURL === worker.url() && item.runningStatus === 'running'), 'No running extension service worker in CDP')
      events.push(...await worker.evaluate(() => __events))
      await worker.evaluate(() => { globalThis.__qaOriginalWorkerGeneration = true })
      await inspector.send('ServiceWorker.stopWorker', { versionId: version.versionId })
      await until(() => events.some(event => event.kind === 'cdp:worker-lifecycle' && event.versionId === version.versionId && event.runningStatus === 'stopped'), 'CDP worker never reached stopped state')
      record('driver:auth-worker-stopped')
      const wakePage = await browser.newPage()
      await wakePage.goto(new URL('popup.html', worker.url()).href)
      worker = await until(async () => {
        for (const candidate of browser.serviceWorkers()) {
          try {
            if (await candidate.evaluate(() => typeof __qaOriginalWorkerGeneration === 'undefined' && typeof NDM_BG !== 'undefined' && NDM_BG.settingsReady && NDM_BG.v && Boolean(NDM_BG.D))) return candidate
          } catch {}
        }
      }, 'No fresh extension worker after actual CDP stop', 15_000)
      await observeWorker(); await wakePage.close(); await page.reload()
      await inspector.detach(); record('driver:auth-worker-restarted', { freshGlobal: true })
    } else if (scenario.authWarmReload) { record('driver:auth-warm-reload'); await page.reload() }
    report.observedBridgeStatus = await worker.evaluate(() => NDM_BG.bridgeStatus || null)
    report.observedPagePolicy = await worker.evaluate(url => {
      const port = Object.values(NDM_BG.H).find(port => port && port.frameId === 0 && port['2'] === url)
      return port ? { documentURL: port['2'], policy: NDM_BG.clickPagePolicies?.[port.tabId] || null } : null
    }, sourceURL)
    if (expectLegacyHost) {
      assert.notEqual(report.observedBridgeStatus?.safeFileRedirects, 1, 'Legacy-host QA must use a real host without the safe redirect capability')
      assert.equal(await worker.evaluate(() => NDM_BG.clickBridgeReady()), false)
    }
    if (scenario.online && !expectLegacyHost && !scenario.authHeader && !scenario.headerPolicies && await worker.evaluate(() => typeof NDM_BG.clickAvailable === 'function')) {
      report.earlyReady = await until(() => worker.evaluate(url => {
        const port = Object.values(NDM_BG.H).find(port => port && port.frameId === 0 && port['2'] === url)
        return port && NDM_BG.clickAvailable(port) ? { tabId: port.tabId, frameId: port.frameId, available: true } : null
      }, sourceURL), 'Early click eligibility never became ready')
      await worker.evaluate(tabId => {
        const port = Object.values(NDM_BG.H).find(port => port && port.frameId === 0 && port.tabId === tabId)
        port.postMessage([28, { available: NDM_BG.clickAvailable(port) }])
      }, report.earlyReady.tabId)
      await delay(50)
    }
    if (scenario.authHeader && !expectLegacyHost && process.env.NDM_QA_RECORD_ONLY !== '1') {
      report.observedAuthBoundary = await until(() => worker.evaluate(url => {
        const port = Object.values(NDM_BG.H).find(port => port && port.frameId === 0 && port['2'] === url)
        return NDM_BG.clickHTTPAuthReady && NDM_BG.clickHTTPAuthOrigins?.has(new URL(url).origin) && port && !NDM_BG.clickAvailable(port) ? { originRemembered: true, earlyAvailable: false, safeHostAvailable: NDM_BG.clickBridgeReady() } : null
      }, sourceURL), 'Known HTTP authentication must disable early interception')
      assert.equal(report.observedAuthBoundary.safeHostAvailable, true, 'Auth fallback proof must use a host that otherwise supports early interception')
    }
    if (scenario.headerPolicies) {
      await until(() => worker.evaluate(url => {
        const port = Object.values(NDM_BG.H).find(port => port && port.frameId === 0 && port['2'] === url)
        return port && NDM_BG.clickPagePolicies[port.tabId] && !NDM_BG.clickAvailable(port)
      }, sourceURL), 'Restrictive HTTP policy must disable early availability')
    }
    if (scenario.prepQueueFull) {
      await worker.evaluate(() => { NDM_BG.relayReservations = new Set(Array.from({ length: 21 }, (_, id) => ({ syntheticQAReservation: id }))) })
      record('fault:relay-admission-filled', { syntheticReservations: 21 })
    }
    const target = page.getByRole('link', { name: 'Download file', exact: true })
    record('driver:click-start')
    if (scenario.keyboard) { await target.focus(); await page.keyboard.press('Enter') }
    else if (scenario.doubleClick) await target.dblclick({ delay: 20, noWaitAfter: true })
    else await target.click({ noWaitAfter: true, ...(scenario.modifiers ? { modifiers: scenario.modifiers } : {}) })
    record('driver:click-end')
    if (scenario.spaNavigation) {
      await delay(80); await page.evaluate(() => history.pushState({}, '', '/changed-route'))
      record('driver:spa-navigation-during-head'); await delay(1_800)
    }
    if (scenario.closePage) {
      await until(() => events.some(event => event.kind === 'proxy:receipt-dropped'), 'Native accepted before page-close fault')
      await page.close(); record('driver:page-closed-after-dropped-ack')
    }
    const result = await until(async () => {
      if (scenario.spaNavigation && new URL(page.url()).pathname === '/changed-route') return { owner: 'page-changed' }
      if (scenario.handled && await page.title() === 'Website owns click') return { owner: 'page-handler' }
      if (scenario.html && await page.title() === 'Safe original HTML navigation') return { owner: 'navigation' }
      const native = host ? (await host.request('list')).tasks.find(item => item.url === targetURL || scenario.redirect && item.url === targetURL.replace('/payload/', '/redirect/') || scenario.crossRedirect && item.url === `http://localhost:${sink.address().port}/sink.zip`) : null
      const downloads = await worker.evaluate(() => chrome.downloads.search({}))
      const complete = downloads.find(item => item.state === 'complete')
      return native?.status === 'complete' ? { owner: 'ndm', task: native, browser: downloads } : complete ? { owner: 'chrome', download: complete, browser: downloads } : null
    }, 'Neither NDM nor browser completed the clicked download', 20_000)
    await delay(scenario.handled ? 1_700 : 500)
    if (scenario.lostAck) { await until(() => events.some(event => event.kind === 'proxy:receipt-forwarded'), 'No same-ID retry receipt after dropping the first real ACK', 15_000); await delay(350) }
    events.push(...await worker.evaluate(() => __events))
    report.result = result.owner
    report.finalBrowserRecords = await worker.evaluate(() => chrome.downloads.search({})).then(items => items.map(({ id, state, paused, error }) => ({ id, state, paused, error })))
    if (!['navigation', 'page-handler', 'page-changed'].includes(result.owner)) {
      const downloadedPath = result.owner === 'ndm' ? join(result.task.folderPath, result.task.filename) : result.download.filename
      report.actualSHA256 = sha256(readFileSync(downloadedPath))
      assert.equal(report.actualSHA256, report.sourceSHA256)
    }
    if (host) report.finalNDMTasks = (await host.request('list')).tasks.map(({ id, status, filename }) => ({ id, status, filename }))
    events.sort((a, b) => a.time - b.time)
    const click = events.find(item => item.kind === 'page:click') || events.find(item => item.kind === 'driver:click-start')
    report.timeline = events.filter(item => !item.url?.endsWith('/page.html')).map(item => ({ ...item, afterClickMs: item.time - click.time }))
    report.metrics = { created: events.filter(item => item.kind === 'chrome:created').length, interrupted: events.filter(item => item.kind === 'chrome:changed' && item.state?.current === 'interrupted').length, erased: events.filter(item => item.kind === 'chrome:erased').length }
    for (const [key, predicate] of Object.entries({ firstBrowserItem: e => e.kind === 'chrome:created', bridgeSend: e => e.kind === 'bridge:download-send', bridgeReceipt: e => e.kind === 'bridge:receipt', hostTask: e => e.kind === 'host:task', hostStarted: e => e.kind === 'host:task' && e.status === 'downloading' })) {
      const event = events.find(predicate); report.metrics[key + 'Ms'] = event ? event.time - click.time : null
    }
    report.metrics.browserHEADs = events.filter(item => item.kind === 'chrome:request' && item.method === 'HEAD').length
    report.metrics.nativeHEADs = events.filter(item => item.kind === 'http:request' && item.method === 'HEAD' && !item.browserFetchMode).length
    if (scenario.download && scenario.zeroNative && process.env.NDM_QA_RECORD_ONLY !== '1' && !expectLegacyHost) assert.equal(report.metrics.browserHEADs, 0, 'Explicit download intent must not be probed by the browser')
    if (scenario.zeroNative && process.env.NDM_QA_RECORD_ONLY !== '1' && !expectLegacyHost) {
      assert.equal(report.result, 'ndm', 'Online supported link must arrive in NDM')
      assert.equal(report.metrics.created, 0, 'No native Chrome download item may ever be created')
      assert.equal(report.metrics.interrupted, 0, 'Native cancellation is not zero-item interception')
      assert.equal(report.metrics.erased, 0, 'History erasure is not zero-item interception')
      assert.equal(report.finalNDMTasks.length, 1, 'One user intent must create one NDM task')
    } else if (expectLegacyHost) {
      assert.equal(events.filter(item => item.kind === 'worker:early-intent').length, 0, 'Host without safe redirects must never receive an early intent')
      assert.equal(report.metrics.browserHEADs, 0)
      assert.equal(report.metrics.created, 1)
    } else if (process.env.NDM_QA_RECORD_ONLY === '1') {
      // Observe a frozen baseline with the same instrumentation.
    } else if (scenario.spaNavigation) {
      assert.equal(report.result, 'page-changed'); assert.equal(report.metrics.created, 0)
      assert.equal(report.finalNDMTasks.length, 0)
      assert.equal(events.filter(item => item.kind === 'bridge:download-send').length, 0)
      assert.equal(await page.locator('#ndm-relay-click-notice').count(), 1, 'The changed-page outcome must be visible')
    } else if (scenario.handled) {
      assert.equal(report.result, 'page-handler'); assert.equal(report.metrics.created, 0)
      assert.equal(report.metrics.browserHEADs, 0, 'A website-cancelled click must not start extension preflight')
      assert.equal(report.finalNDMTasks.length, 0, 'A website-owned click must not create an NDM task')
    } else if (scenario.html) {
      assert.equal(report.result, 'navigation'); assert.equal(report.metrics.created, 0)
      assert.equal(report.finalNDMTasks.length, 0, 'HTML must never become a download task')
    } else {
      assert.equal(report.metrics.created, 1, 'Unsupported or offline click must preserve the natural browser item')
      if (!scenario.online) { assert.equal(report.result, 'chrome'); assert.equal(report.metrics.interrupted, 0); assert.equal(report.metrics.erased, 0) }
    }
    if (scenario.doubleClick) assert.equal(events.filter(item => item.kind === 'page:click' && item.trusted).length, 2)
    if (scenario.lostAck) {
      const dropped = events.filter(item => item.kind === 'proxy:receipt-dropped')
      const sent = events.filter(item => item.kind === 'bridge:download-send')
      assert.equal(dropped.length, 1); assert.ok(sent.length >= 2, 'Lost ACK must produce a durable retry')
      assert.equal(new Set(sent.map(item => item.requestID)).size, 1, 'Retries must retain the same request ID')
    }
    if (scenario.pageHash) {
      const initialRequests = events.filter(item => item.kind === 'http:request')
      assert.ok(initialRequests.length)
      assert.equal(initialRequests.some(item => item.refererHasFragment || !item.authenticated), false, 'Native Referer must omit entire page fragment while retaining same-origin authentication')
    }
    if (scenario.prepQueueFull) {
      assert.equal(report.result, 'chrome', 'A full preparation queue must preserve the browser fallback')
      assert.equal(report.finalNDMTasks.length, 0)
      assert.equal(report.metrics.interrupted, 0); assert.equal(report.metrics.erased, 0)
      assert.equal(events.filter(item => item.kind === 'worker:early-intent').length, 1)
      assert.equal(events.filter(item => item.kind === 'bridge:download-send').length, 0, 'Preparation failure must not send or be recaptured by legacy handoff')
    }
    if (scenario.rejectFirst) {
      assert.equal(report.result, 'chrome', 'First proven rejection must fall back to Chrome')
      assert.equal(report.finalNDMTasks.length, 0, 'Rejected native request must not create a task')
      assert.equal(report.metrics.created, 1); assert.equal(report.metrics.interrupted, 0); assert.equal(report.metrics.erased, 0)
      assert.equal(events.filter(item => item.kind === 'proxy:request-rejected-before-native').length, 1)
      assert.equal(events.filter(item => item.kind === 'bridge:download-send').length, 1, 'Legacy catcher must not recapture fallback')
    }
    if (scenario.noEarlyIntent) {
      assert.equal(events.filter(item => item.kind === 'worker:early-intent').length, 0, 'Restrictive policy must never start early handoff')
      assert.equal(report.metrics.browserHEADs, 0, 'Restrictive policy must not preflight')
      assert.equal(report.result, 'chrome', 'Unsupported authenticated/policy link remains Chrome-owned')
      assert.equal(report.finalNDMTasks.length, 0)
      assert.equal(events.filter(item => item.kind === 'bridge:download-send').length, 0, 'Unsupported known authentication must not be captured by the legacy path')
      assert.equal(report.metrics.interrupted, 0); assert.equal(report.metrics.erased, 0)
    }
    if (scenario.authHeader) {
      assert.ok(events.some(event => event.kind === 'http:request' && event.authorizationPresent), 'The real browser must send its cached HTTP authentication to the protected source')
    }
    if (scenario.crossRedirect) {
      report.privacy = { initialAuthorizationPresent: events.some(event => event.kind === 'http:request' && event.authorizationPresent), sinkRequests: events.filter(event => event.kind === 'http:cross-origin-sink') }
      assert.ok(report.privacy.sinkRequests.length, 'Cross-origin sink must actually be reached')
      assert.equal(report.privacy.sinkRequests.some(event => event.cookiePresent || event.authorizationPresent || event.refererContainsSyntheticPageToken), false, 'Cross-origin redirect must not forward origin-bound cookie/auth or full private page Referer')
    }
    if (!page.isClosed()) await page.screenshot({ path: join(evidence, scenario.name + '.png'), fullPage: true })
    if (scenario.name === 'ordinary-online') {
      const downloadPage = await browser.newPage(); await downloadPage.goto('chrome://downloads/'); await delay(150)
      await downloadPage.screenshot({ path: join(evidence, 'chrome-downloads.png'), fullPage: true })
    }
    report.observationComplete = true
  } catch (error) {
    report.failure = String(error.stack || error)
    if (worker) {
      try {
        const captured = await worker.evaluate(() => __events)
        for (const event of captured) if (!events.some(item => item.time === event.time && item.kind === event.kind && item.id === event.id)) events.push(event)
        report.finalBrowserRecords = await worker.evaluate(() => chrome.downloads.search({})).then(items => items.map(({ id, state, paused, error }) => ({ id, state, paused, error })))
      } catch {}
    }
    if (host) {
      try { report.finalNDMTasks = (await host.request('list')).tasks.map(({ id, status, filename, error }) => ({ id, status, filename, error })) } catch {}
    }
  }
  finally {
    if (host) {
      try { for (const task of (await host.request('list')).tasks) await host.request('remove', { taskID: task.id, deleteFile: true }); assert.deepEqual((await host.request('list')).tasks, []) } catch (error) { cleanupFailures.push(error.message) }
    }
    await browser?.close().catch(error => cleanupFailures.push(error.message))
    host?.close()
    await proxy?.close().catch(error => cleanupFailures.push(error.message))
    if (processHost?.pid) { try { process.kill(-processHost.pid, 'SIGTERM') } catch {} }
    try { await until(async () => !await portTaken(port) && !await portTaken(bridge), 'QA ports remained open', 5_000) } catch (error) { cleanupFailures.push(error.message) }
    sink?.closeAllConnections(); if (sink?.listening) await new Promise(done => sink.close(done))
    server?.closeAllConnections(); if (server?.listening) await new Promise(done => server.close(done))
    try {
      const preferences = readPreferences(suite)
      if (preferences !== null) {
        const value = preferences.match(/<key>AppSettingsJSON<\/key>\s*<data>([\s\S]*?)<\/data>/)?.[1]
        const settings = JSON.parse(Buffer.from(value.replace(/\s/g, ''), 'base64').toString())
        assert.equal(settings.bridgePort, bridge); assert.equal(settings.downloadDirectory, downloads)
        assert.equal(spawnSync('/usr/bin/defaults', ['delete', suite]).status, 0)
      }
      if (existsSync(plist)) assert.equal(spawnSync('/usr/bin/trash', [plist]).status, 0)
      assert.equal(readPreferences(suite), null)
      report.preferencesCleaned = true
    } catch (error) { cleanupFailures.push('preferences: ' + error.message) }
    assert.equal(spawnSync('/usr/bin/trash', [root]).status, 0)
    report.cleanupFailures = cleanupFailures
    writeFileSync(join(evidence, scenario.name + '.json'), JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify({ name: report.name, result: report.result, metrics: report.metrics, failure: report.failure, cleanupFailures }))
  return report
}
const cases = [
  { name: 'cross-origin-download-redirect', online: true, auth: true, redirect: true, crossRedirect: true, download: true, zeroNative: true },
  { name: 'multiple-meta-no-referrer', online: true, download: true, metaPolicies: true, noEarlyIntent: true },
  { name: 'removed-meta-no-referrer', online: true, download: true, metaRemoved: true, noEarlyIntent: true },
  { name: 'multiple-http-no-referrer', online: true, download: true, headerPolicies: true, noEarlyIntent: true },
  { name: 'preparation-queue-full', online: true, prepQueueFull: true },
  { name: 'native-first-rejection', online: true, rejectFirst: true },
  { name: 'lost-ack-close-page', online: true, zeroNative: true, lostAck: true, closePage: true },
  { name: 'cross-origin-basic-auth-redirect', online: true, auth: true, redirect: true, crossRedirect: true, authHeader: true, download: true, noEarlyIntent: true },
  { name: 'warmed-basic-auth-redirect', online: true, auth: true, redirect: true, crossRedirect: true, authHeader: true, authWarmReload: true, download: true, noEarlyIntent: true },
  { name: 'direct-basic-auth-cold', online: true, auth: true, authHeader: true, noEarlyIntent: true },
  { name: 'direct-basic-auth-warm', online: true, auth: true, authHeader: true, authWarmReload: true, noEarlyIntent: true },
  { name: 'direct-basic-auth-worker-restart', online: true, auth: true, authHeader: true, authWorkerRestart: true, noEarlyIntent: true },
  { name: 'hash-page-referrer', online: true, auth: true, download: true, pageHash: true, zeroNative: true },
  { name: 'keyboard-enter-online', online: true, zeroNative: true, keyboard: true },
  { name: 'noreferrer-natural-fallback', online: true, download: true, noreferrer: true, noEarlyIntent: true },
  { name: 'anchor-no-referrer-fallback', online: true, download: true, noReferrer: true, noEarlyIntent: true },
  { name: 'ordinary-online', online: true, zeroNative: true },
  { name: 'download-attribute-online', online: true, download: true, zeroNative: true },
  { name: 'download-query-no-preflight', online: true, download: true, query: true, zeroNative: true },
  { name: 'authenticated-download-redirect-online', online: true, auth: true, redirect: true, download: true, zeroNative: true },
  { name: 'plain-redirect-online', online: true, auth: true, redirect: true },
  { name: 'ordinary-offline', online: false },
  { name: 'head405-online', online: true, head405: true },
  { name: 'head-timeout-online', online: true, headTimeout: true },
  { name: 'spa-navigation-during-head', online: true, headTimeout: true, spaNavigation: true },
  { name: 'website-handled-link', online: true, handled: true },
  { name: 'html-masquerading-as-zip', online: true, html: true },
  { name: 'token-query-natural-fallback', online: true, query: true },
  { name: 'double-click-online', online: true, zeroNative: true, doubleClick: true },
  { name: 'lost-native-ack', online: true, zeroNative: true, lostAck: true }
].filter(scenario => !process.env.NDM_QA_CASE || process.env.NDM_QA_CASE.split(',').includes(scenario.name))

assert.ok(cases.length, 'NDM_QA_CASE must match at least one supported scenario')
const reports = []
for (const scenario of cases) reports.push(await runCase(scenario))
writeFileSync(join(evidence, 'summary.json'), JSON.stringify(reports.map(({ name, result, metrics, failure, cleanupFailures }) => ({ name, result, metrics, failure, cleanupFailures })), null, 2))
if (reports.some(report => report.failure || report.cleanupFailures.length)) process.exitCode = 1
