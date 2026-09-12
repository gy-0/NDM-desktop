// Real Chrome extension + isolated cookie profile + loopback wire receiver.
// No production NDM, browser profile, downloads, or login cookies are used.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Reuse the WebSocket server bundled with the existing QA dependency.
const require = createRequire(import.meta.url)
const { wsServer: WebSocketServer } = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'))

const root = mkdtempSync(join(tmpdir(), 'ndm-relay-session-wire-'))
const owned = join(root, 'owned'), extension = join(owned, 'extension')
mkdirSync(owned, { recursive: true })
cpSync(resolve('extension/NDMRelay'), extension, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const report = { passed: false, root, scope: 'Real Chrome extension in a disposable profile; synthetic authenticated HTTP and routed YouTube DOM; bridge wire only, no native task creation', scenarios: [], workerSHA256: sha(readFileSync(join(extension, 'bg.js'))), sessionSHA256: sha(readFileSync(join(extension, 'session-cookies.js'))) }
const ordinaryPath = '/private/manual.zip'
const mediaURL = 'https://www.youtube.com/watch?v=synthetic_session_fixture'
const records = [], connections = new Set(), sessionIDs = [], refreshResponses = new Map(), refreshExpectations = new Map()
let context, receiverFailure, authenticatedHTTP = 0, rejectedHTTP = 0
function check(value, message) { assert.ok(value, message) }
function parseWire(payload) {
  const fields = {}
  for (const line of payload.split('\r\n')) {
    const at = line.indexOf(':')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}
function cookieNames(header = '') { return header.split(/;\s*/).filter(Boolean).map(item => item.slice(0, item.indexOf('='))).sort() }
function jarHasValue(encoded, name, expected) {
  return Buffer.from(encoded, 'base64').toString('utf8').split('\n').some(line => {
    const fields = line.split('\t')
    return fields.length === 7 && fields[5] === name && fields[6] === expected
  })
}
function jarMetadata(encoded) {
  const text = Buffer.from(encoded, 'base64').toString('utf8')
  check(text.startsWith('# Netscape HTTP Cookie File\n'), 'Expected a Netscape cookie file')
  return text.split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
    const [domain, includeSubdomains, path, secure, expiration, name, value] = line.split('\t')
    check(value !== undefined, 'Cookie row is missing fields')
    return { domain: domain.replace(/^#HttpOnly_/, ''), httpOnly: domain.startsWith('#HttpOnly_'), includeSubdomains: includeSubdomains === 'TRUE', path, secure: secure === 'TRUE', session: expiration === '0', name }
  })
}
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['qa_root=synthetic_root; Path=/; SameSite=Lax', 'qa_http=synthetic_http_only; HttpOnly; Path=/private; SameSite=Lax', 'qa_wrong_path=synthetic_excluded; Path=/account; SameSite=Lax'] })
    response.end('<!doctype html><title>NDM authenticated attachment QA</title><a href="/private/manual.zip">Download fixture</a>')
    return
  }
  if (request.url !== ordinaryPath) { response.writeHead(404).end(); return }
  const names = cookieNames(request.headers.cookie)
  if (!names.includes('qa_root') || !names.includes('qa_http') || names.includes('qa_wrong_path')) { rejectedHTTP++; response.writeHead(401).end(); return }
  authenticatedHTTP++
  const bytes = Buffer.alloc(128 * 1024, 65)
  response.writeHead(200, { 'Content-Disposition': 'attachment; filename="manual.zip"', 'Content-Type': 'application/zip', 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' })
  if (request.method === 'HEAD') { response.end(); return }
  response.write(bytes.subarray(0, 1024))
  const timer = setTimeout(() => response.end(bytes.subarray(1024)), 3000)
  response.on('close', () => clearTimeout(timer))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const fileURL = `http://127.0.0.1:${server.address().port}${ordinaryPath}`
const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise(resolve => receiver.once('listening', resolve))
receiver.on('connection', socket => {
  connections.add(socket)
  socket.on('close', () => connections.delete(socket))
  socket.on('message', data => {
    try {
      const message = data.toString()
      if (message.startsWith('NDMRelayHello:')) {
        socket.send('NDMRelayStatus:' + JSON.stringify({ protocol: 1, expectedVersion: null, durableHandoff: 1 }))
        socket.send('nowaiting')
        return
      }
      if (message.startsWith('NDMRelaySessionResponse:')) {
        const reply = JSON.parse(message.slice('NDMRelaySessionResponse:'.length))
        const expected = refreshExpectations.get(reply.requestId)
        check(expected && reply.sessionID === expected.sessionID, 'Refresh response did not match its opaque token and request')
        const cookies = jarMetadata(reply.cookies)
        check(cookies.length === expected.count, 'Refresh returned an unexpected cookie count')
        check(cookies.every(cookie => ['qa_yt_session', 'qa_yt_host'].includes(cookie.name) && ['.youtube.com', 'www.youtube.com'].includes(cookie.domain)), 'Refresh included a different site or path cookie')
        if (expected.value) check(jarHasValue(reply.cookies, 'qa_yt_session', expected.value), 'Refresh reused a previous cookie value')
        check(!refreshResponses.has(reply.requestId), 'More than one browser worker answered the session request')
        refreshResponses.set(reply.requestId, { cookieCount: cookies.length, cookies, freshValue: !!expected.value, emptySession: cookies.length === 0 })
        return
      }
      let payload = message, requestId
      if (message.startsWith('NDMRelayDownload:')) ({ payload, requestId } = JSON.parse(message.slice('NDMRelayDownload:'.length)))
      if (!payload.startsWith('1:')) return
      const wire = parseWire(payload), names = cookieNames(wire.Cookie)
      if (wire['2'] === fileURL) {
        check(wire['6'] === 'normal', 'Attachment lost its normal-download type')
        check(names.includes('qa_root') && names.includes('qa_http'), 'Attachment lost eligible browser session cookies')
        check(!names.includes('qa_wrong_path') && !names.includes('qa_other_site'), 'Attachment included an unrelated cookie')
        records.push({ scenario: 'ordinary-attachment', cookieNames: names, durableEnvelope: !!requestId, capturedSession: true })
      } else if (wire['2'] === mediaURL) {
        check(wire['6'] === 'media-page', 'Media page lost its resolver type')
        check(wire['13'] === 'chrome', 'Wire field 13 did not identify Chrome')
        check(Boolean(wire['14']), 'Wire field 14 is missing its scoped jar')
        check(/^[0-9a-f-]{36}$/i.test(wire['15'] || ''), 'Wire field 15 is missing its opaque session token')
        check(!sessionIDs.includes(wire['15']), 'A new handoff reused a previous session token')
        const cookies = jarMetadata(wire['14'])
        if (sessionIDs.length === 0) {
          const session = cookies.find(cookie => cookie.name === 'qa_yt_session')
          const host = cookies.find(cookie => cookie.name === 'qa_yt_host')
          check(session?.httpOnly && session.secure && session.path === '/watch' && session.domain === '.youtube.com' && session.includeSubdomains, 'Media jar changed HttpOnly/domain/path/secure scope')
          check(host?.domain === 'www.youtube.com' && !host.includeSubdomains && host.path === '/', 'Media jar lost host-only cookie scope')
          check(cookies.length === 2 && cookies.every(cookie => ['qa_yt_session', 'qa_yt_host'].includes(cookie.name)), 'Media jar included unrelated site or path cookies')
          check(names.length === 2 && !names.includes('qa_yt_account') && !names.includes('qa_google_other'), 'Flat media header included unrelated cookies')
          records.push({ scenario: 'media-page', browser: wire['13'], sessionTokenPresent: true, jarBytes: Buffer.from(wire['14'], 'base64').length, cookies })
        } else {
          check(cookies.length === 0 && names.length === 0 && !wire.Authorization, 'Anonymous handoff reused the previous authentication')
          records.push({ scenario: 'same-url-anonymous-handoff', newSessionToken: true, cookieCount: cookies.length, oldAuthenticationAbsent: true })
        }
        sessionIDs.push(wire['15'])
      } else throw Error('Unexpected URL reached the isolated bridge')
      if (requestId) socket.send('NDMRelayReceipt:' + JSON.stringify({ requestId, status: 'accepted', taskID: 'synthetic-wire-receiver' }))
    } catch (error) { receiverFailure = error }
  })
})
function askRefresh(requestId, sessionID, expected, url = mediaURL) {
  refreshExpectations.set(requestId, { sessionID, ...expected })
  for (const socket of connections) if (socket.readyState === 1) socket.send('NDMRelaySessionRequest:' + JSON.stringify({ requestId, sessionID, url }))
}
async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (receiverFailure) throw receiverFailure
    const result = await fn()
    if (result) return result
    await delay(50)
  }
  throw Error(message)
}
try {
  const background = join(extension, 'bg.js')
  const source = readFileSync(background, 'utf8')
  const patched = source.replace(/this.bridgeEndpoints = \[.*?\];/, `this.bridgeEndpoints = ["ws://127.0.0.1:${receiver.address().port}/ndm/download"];`)
  check(patched !== source, 'Could not isolate bridge endpoints')
  writeFileSync(background, patched)
  context = await chromium.launchPersistentContext(join(owned, 'profile'), {
    executablePath: process.env.NDM_QA_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: join(owned, 'downloads'),
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], timeout: 20000
  })
  const cdp = await context.browser().newBrowserCDPSession()
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension })
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  let worker = context.serviceWorkers().find(worker => worker.url().endsWith('/bg.js')) || await context.waitForEvent('serviceworker')
  await until(() => worker.evaluate(() => globalThis.NDM_BG?.bridgeStatus?.durableHandoff === 1), 'Extension did not connect to the isolated bridge')
  await worker.evaluate(() => {
    globalThis.__sessionRequests = []
    const original = NDM_BG.relayWithCookies
    NDM_BG.relayWithCookies = function(request, callback) {
      __sessionRequests.push({ url: request['2'], tabId: request.tabId, frameId: request.frameId })
      return original(request, callback)
    }
  })
  const filePage = await context.newPage()
  await filePage.goto(`http://127.0.0.1:${server.address().port}/`)
  check(!await filePage.evaluate(() => document.cookie.includes('qa_http=')), 'HttpOnly attachment cookie leaked to page JavaScript')
  await filePage.getByRole('link', { name: 'Download fixture' }).click()
  await until(() => records.find(record => record.scenario === 'ordinary-attachment'), 'Attachment did not reach the bridge')
  check(authenticatedHTTP > 0 && rejectedHTTP === 0, 'Browser attachment request did not carry a valid synthetic session')
  await until(() => worker.evaluate(() => !NDM_BG.browserHandoffs.hasPending()), 'Attachment receipt did not settle')
  report.scenarios.push({ ...records.find(record => record.scenario === 'ordinary-attachment'), authenticatedHTTP, rejectedHTTP, pageCannotReadHttpOnly: true })
  await context.addCookies([
    { name: 'qa_yt_session', value: 'synthetic_youtube_session', domain: '.youtube.com', path: '/watch', secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'qa_yt_host', value: 'synthetic_host_session', domain: 'www.youtube.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
    { name: 'qa_yt_account', value: 'synthetic_wrong_path', domain: '.youtube.com', path: '/account', secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'qa_google_other', value: 'synthetic_other_site', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
  ])
  const mediaPage = await context.newPage()
  await mediaPage.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic YouTube session QA</title><style>body{font-family:Arial;padding:32px}#top-level-buttons-computed{display:flex}</style><video style="width:640px;height:360px"></video><ytd-watch-metadata><div id="top-level-buttons-computed"><button>Share</button></div></ytd-watch-metadata>' }))
  await mediaPage.goto(mediaURL)
  check(!await mediaPage.evaluate(() => document.cookie.includes('qa_yt_session=')), 'HttpOnly media cookie leaked to page JavaScript')
  await mediaPage.locator('[data-better-ndm-site-action="youtube"]').click()
  await until(() => records.find(record => record.scenario === 'media-page'), 'Native video action did not hand off its session')
  const tabScope = await worker.evaluate(async ({ fileURL, mediaURL }) => {
    const tabs = await chrome.tabs.query({})
    return [fileURL, mediaURL].map(url => {
      const request = __sessionRequests.find(request => request.url === url)
      const tab = tabs.find(tab => tab.id === request?.tabId)
      return { kind: url === mediaURL ? 'media' : 'attachment', hasTab: Number.isInteger(request?.tabId), frameId: request?.frameId, matchesInitiatingPage: url === mediaURL ? tab?.url === mediaURL : tab?.url === new URL('/', fileURL).href }
    })
  }, { fileURL, mediaURL })
  check(tabScope.every(scope => scope.hasTab && scope.frameId === 0 && scope.matchesInitiatingPage), 'Session collection did not receive the initiating tab/frame')
  report.scenarios.push({ ...records.find(record => record.scenario === 'media-page'), pageCannotReadHttpOnly: true })
  report.tabScope = tabScope

  // Refresh reads the browser again rather than replaying the first wire jar.
  const updatedCookie = { name: 'qa_yt_session', value: 'synthetic_rotated_session', domain: '.youtube.com', path: '/watch', secure: true, httpOnly: true, sameSite: 'Lax' }
  await context.addCookies([updatedCookie])
  askRefresh('rotated-session', sessionIDs[0], { count: 2, value: updatedCookie.value })
  await until(() => refreshResponses.get('rotated-session'), 'Session refresh did not return the current cookie')
  report.scenarios.push({ scenario: 'refresh-after-cookie-rotation', ...refreshResponses.get('rotated-session') })

  await context.clearCookies({ name: 'qa_yt_session' })
  await context.clearCookies({ name: 'qa_yt_host' })
  await mediaPage.locator('[data-better-ndm-site-action="youtube"]').click()
  await until(() => sessionIDs.length === 2, 'Anonymous handoff did not create a separate session token')
  report.scenarios.push(records.find(record => record.scenario === 'same-url-anonymous-handoff'))
  askRefresh('signed-out-old-token', sessionIDs[0], { count: 0 })
  await until(() => refreshResponses.get('signed-out-old-token'), 'Signed-out session refresh was not returned')
  report.scenarios.push({ scenario: 'old-token-after-sign-out', ...refreshResponses.get('signed-out-old-token') })

  const registryBefore = await worker.evaluate(async identifiers => {
    const rows = (await chrome.storage.session.get('ndm.relayMediaSessions.v1'))['ndm.relayMediaSessions.v1'] || []
    const ours = rows.filter(row => identifiers.includes(row.id))
    return { count: ours.length, storeIds: [...new Set(ours.map(row => row.context.storeId))],
      onlyRouting: ours.every(row => Object.keys(row.context).every(key => ['url', 'tabId', 'frameId', 'storeId', 'partitionKey', 'pinnedContext'].includes(key))),
      containsCredentialFields: /qa_yt_|"cookies"|"value"|"Cookie"/.test(JSON.stringify(ours)) }
  }, sessionIDs)
  check(registryBefore.count === 2 && registryBefore.onlyRouting && !registryBefore.containsCredentialFields, 'Session registry persisted credential material')
  check(registryBefore.storeIds.length === 1 && typeof registryBefore.storeIds[0] === 'string', 'Session registry did not pin the originating cookie store')

  // Stop/start the actual service worker without reloading the extension; a
  // runtime.reload would clear storage.session and test a different lifecycle.
  const workerCDP = await context.newCDPSession(popup), versions = new Map(), stoppedVersions = new Set()
  workerCDP.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) { versions.set(version.versionId, version); if (version.runningStatus === 'stopped') stoppedVersions.add(version.versionId) }
  })
  await workerCDP.send('ServiceWorker.enable')
  const version = await until(() => [...versions.values()].find(version => version.scriptURL === worker.url() && version.runningStatus === 'running'), 'Could not observe the running extension worker')
  const previousWorker = worker
  await worker.evaluate(() => { globalThis.__qaBootMarker = true })
  // Track the event, not only the last status: a connected content script can
  // wake the worker before a polling read observes its brief stopped state.
  await workerCDP.send('ServiceWorker.stopWorker', { versionId: version.versionId })
  await until(() => stoppedVersions.has(version.versionId), 'Chrome did not stop the extension service worker')
  await workerCDP.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${id}/` })
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'relay:getState', tabId: 0 }))
  worker = await until(async () => {
    const candidate = context.serviceWorkers().find(candidate => candidate.url() === previousWorker.url())
    if (!candidate) return null
    const fresh = await candidate.evaluate(() => !globalThis.__qaBootMarker && globalThis.NDM_BG?.bridgeStatus?.durableHandoff === 1).catch(() => false)
    return fresh && candidate
  }, 'Restarted worker did not reconnect with a fresh JavaScript global')
  const restored = await worker.evaluate(async ({ identifiers, url }) => {
    const registry = NDM_BG.mediaSessionRegistry()
    const rows = await Promise.all(identifiers.map(id => registry.find(id, url)))
    return { count: rows.filter(Boolean).length, storeIds: [...new Set(rows.filter(Boolean).map(row => row.storeId))] }
  }, { identifiers: sessionIDs, url: mediaURL })
  check(restored.count === 2 && JSON.stringify(restored.storeIds) === JSON.stringify(registryBefore.storeIds), 'Restart lost the token registry or cookie store')
  await worker.evaluate(() => {
    globalThis.__refreshAudit = []
    const originalRefresh = NDM_BG.refreshMediaSession
    NDM_BG.refreshMediaSession = async function(request) {
      try { return await originalRefresh(request) }
      finally { __refreshAudit.push({ requestId: request.requestId, finished: true }) }
    }
    const originalCapture = NDMRelaySessionCookies.capture
    NDMRelaySessionCookies.capture = async function(chrome, request) {
      __refreshAudit.push({ storeId: request.storeId, pinnedContext: request.pinnedContext, url: request.url })
      return originalCapture(chrome, request)
    }
  })
  await mediaPage.route('https://other-site.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Different site</title>' }))
  await mediaPage.goto('https://other-site.invalid/')
  const restoredCookie = { ...updatedCookie, value: 'synthetic_after_worker_restart' }
  await context.addCookies([restoredCookie, { name: 'qa_yt_host', value: 'synthetic_restored_host', domain: 'www.youtube.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' }, { name: 'qa_other_domain', value: 'synthetic_other_domain', domain: 'other-site.invalid', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
  askRefresh('restart-original-token', sessionIDs[0], { count: 2, value: restoredCookie.value })
  askRefresh('restart-anonymous-token', sessionIDs[1], { count: 2, value: restoredCookie.value })
  await until(() => refreshResponses.has('restart-original-token') && refreshResponses.has('restart-anonymous-token'), 'Restored tokens did not read current browser cookies')
  const captureAudit = await worker.evaluate(() => __refreshAudit.filter(row => row.storeId !== undefined))
  check(captureAudit.length === 2 && captureAudit.every(row => row.pinnedContext === true && row.storeId === registryBefore.storeIds[0] && row.url === mediaURL), 'Refresh followed the navigated tab into a different cookie context')
  report.scenarios.push({ scenario: 'service-worker-stop-start', recreatedWorker: true, restoredTokens: restored.count, routingOnlyRegistry: true, initiatingTabNavigatedAway: true, sameCookieStore: true, bothTokensReadCurrentCookies: true, cookies: refreshResponses.get('restart-original-token').cookies })

  for (const invalid of [{ id: 'wrong-domain', token: sessionIDs[0], url: 'https://other-site.invalid/' }, { id: 'wrong-path', token: sessionIDs[0], url: 'https://www.youtube.com/account' }, { id: 'unknown-token', token: '11111111-1111-4111-8111-111111111111', url: mediaURL }]) {
    askRefresh(invalid.id, invalid.token, { count: -1 }, invalid.url)
    await until(() => worker.evaluate(requestId => __refreshAudit.some(row => row.requestId === requestId && row.finished), invalid.id), 'Invalid request was not processed by the worker')
    check(!refreshResponses.has(invalid.id), 'Worker answered a request outside its session identity')
  }
  // The successful response is a wire barrier on the same ordered socket:
  // an incorrectly emitted rejection-path response must be processed before it.
  askRefresh('identity-validation-barrier', sessionIDs[0], { count: 2, value: restoredCookie.value })
  await until(() => refreshResponses.has('identity-validation-barrier'), 'Refresh validation barrier did not arrive')
  report.scenarios.push({ scenario: 'invalid-refresh-identity', wrongDomainRejected: true, wrongPathRejected: true, unknownTokenRejected: true })
  report.extensionVersion = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version
  report.browserVersion = context.browser().version()
  report.passed = true
} catch (error) { report.failure = error.message }
finally {
  if (context) await context.close()
  for (const socket of connections) socket.terminate()
  await new Promise(resolve => receiver.close(resolve))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  check(lstatSync(owned).isDirectory() && !lstatSync(owned).isSymbolicLink(), 'Unexpected QA cleanup path')
  rmSync(owned, { recursive: true })
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) process.exitCode = 1
}
