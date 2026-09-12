import { fileURLToPath as repositoryFileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { completeOnboarding } from './qa-env.mjs'
import { inspectToolbar } from './qa-relay-toolbar.mjs'

const mediaShelfMode = process.env.NDM_QA_MEDIA_SHELF === '1'

const appPath = process.env.NDM_QA_APP_PATH?.trim()
const repositoryPath = repositoryFileURLToPath(new URL('..', import.meta.url))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
async function unusedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}
const hostPort = Number(process.env.NDM_QA_HOST_PORT || await unusedPort())
let bridgePort = Number(process.env.NDM_QA_BRIDGE_PORT || await unusedPort())
while (bridgePort === hostPort) bridgePort = await unusedPort()
if ([hostPort, bridgePort].some(port => !Number.isInteger(port) || port < 1024 || port > 65535 || [51873, 51874, 10007].includes(port))) {
  throw new Error('Relay QA requires isolated non-production host and bridge ports')
}

// Never attach to a listener that existed before this isolated QA launched.
async function portTaken(port) {
  return new Promise((resolve) => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
    setTimeout(() => { probe.destroy(); resolve(false) }, 800)
  })
}
if (await portTaken(hostPort)) {
  throw new Error(`QA host port ${hostPort} is busy`)
}
if (await portTaken(bridgePort)) {
  throw new Error(`QA bridge port ${bridgePort} is busy`)
}
const contentsPath = appPath?.replace(/\/Contents\/MacOS\/[^/]+$/, '/Contents')
const extensionSource = contentsPath ? `${contentsPath}/Resources/extension/NDMRelay` : join(repositoryPath, 'extension/NDMRelay')
const ffmpegPath = process.env.NDM_QA_FFMPEG_PATH || (contentsPath ? `${contentsPath}/Resources/Tools/ffmpeg` : join(repositoryPath, 'native/Vendor/Tools/ffmpeg'))
if (!existsSync(`${extensionSource}/manifest.json`)) {
  throw new Error(`Relay is missing: ${extensionSource}`)
}
if (!existsSync(ffmpegPath)) throw new Error(`QA ffmpeg is missing: ${ffmpegPath}`)

const qaRoot = mkdtempSync('/tmp/ndm-relay-browser-qa-')
const supportPath = `${qaRoot}/unused-engine`
// Must match SettingsStore.activeDefaults(): FNV-1a over the exact UTF-8 path.
let suiteHash = 0xcbf29ce484222325n
for (const byte of Buffer.from(supportPath)) suiteHash = BigInt.asUintN(64, (suiteHash ^ BigInt(byte)) * 0x100000001b3n)
const defaultsSuite = `ndm.support.${suiteHash.toString(16)}`
const defaultsPlist = join(homedir(), 'Library/Preferences', `${defaultsSuite}.plist`)
function readOwnedDefaults() {
  const probe = spawnSync('/usr/bin/defaults', ['read', defaultsSuite], { encoding: 'utf8' })
  if (probe.status !== 0) {
    if (/does not exist|not found/i.test(probe.stderr || probe.stdout)) return null
    throw new Error(`Unable to query the exact QA preferences suite (exit ${probe.status})`)
  }
  const exported = spawnSync('/usr/bin/defaults', ['export', defaultsSuite, '-'], { encoding: 'utf8' })
  if (exported.status === 0) return /<dict\s*\/>|<dict>\s*<\/dict>/.test(exported.stdout) ? null : exported.stdout
  if (/does not exist/i.test(exported.stderr || exported.stdout)) return null
  throw new Error(`Unable to inspect the exact QA preferences suite (exit ${exported.status})`)
}
if (existsSync(defaultsPlist) || readOwnedDefaults() !== null) throw new Error('QA preferences suite existed before launch; refusing to reuse it')
const extensionPath = `${qaRoot}/extension/NDMRelay`
const evidencePath = process.env.NDM_QA_OUTPUT_DIR && resolve(process.env.NDM_QA_OUTPUT_DIR)
const report = { passed: false, mediaShelfMode, hostPort, bridgePort, packaged: Boolean(appPath), extensionSource, supportPath, defaultsSuite, preferencesAbsentBeforeLaunch: true, runtimeEndpointOverridesOnly: true, checks: {} }
if (evidencePath) mkdirSync(evidencePath, { recursive: true })
cpSync(extensionSource, extensionPath, { recursive: true })
for (const file of ['bg.js', 'popup.js']) {
  const source = readFileSync(join(extensionSource, file), 'utf8')
  const configured = source.replaceAll('ws://127.0.0.1:51873/ndm/download', `ws://127.0.0.1:${bridgePort}/ndm/download`).replaceAll('ws://127.0.0.1:10007/ndm/download', `ws://127.0.0.1:${bridgePort}/ndm/download`)
  writeFileSync(join(extensionPath, file), configured)
}
report.extensionSourceSHA256 = Object.fromEntries(['bg.js', 'ct.js', 'popup.js', 'popup.css', 'popup.html'].map(file => [file, sha256(readFileSync(join(extensionSource, file)))]))
report.handoffSourceSHA256 = sha256(readFileSync(join(extensionSource, 'browser-handoff.js')))
if (report.handoffSourceSHA256 !== sha256(readFileSync(join(extensionPath, 'browser-handoff.js')))) throw new Error('QA changed the handoff implementation')
const profilePath = `${qaRoot}/chromium-profile`
const electronProfilePath = `${qaRoot}/electron-profile`
const downloads = `${qaRoot}/downloads`
const filename = `ndm-relay-browser-qa-${process.pid}.mp4`
const sourcePath = `${qaRoot}/${filename}`
const sessionCookie = `ndm_relay_session=qa-${process.pid}`
const authorization = `Bearer relay-qa-${process.pid}`
const downloadNonce = `nonce-${process.pid}`
let authenticatedMediaRequests = 0
mkdirSync(profilePath, { recursive: true })
mkdirSync(electronProfilePath, { recursive: true })
mkdirSync(downloads, { recursive: true })

const generated = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=duration=12:size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-c:v', 'mpeg4', '-b:v', '2M', '-c:a', 'aac',
  '-movflags', '+faststart', '-y', sourcePath
], { encoding: 'utf8' })
if (generated.status !== 0 || !existsSync(sourcePath)) {
  throw new Error(`packaged ffmpeg could not generate Relay QA media: ${generated.stderr || generated.stdout}`)
}
const payload = readFileSync(sourcePath)
if (payload.length < 1_000_000) throw new Error(`Relay QA media is unexpectedly small: ${payload.length} bytes`)

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (pathname === '/' || pathname === '/page.html') {
    const body = Buffer.from(`<!doctype html>
      <html lang="zh-CN">
        <head><meta charset="utf-8"><title>NDM Relay 浏览器验收</title></head>
        <body style="margin:40px;background:#171513;color:#f7efe2;font:16px system-ui">
          <h1>NDM Relay 浏览器验收</h1>
          <p>Authenticated browser-session handoff</p>
        </body>
      </html>`)
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Set-Cookie': `${sessionCookie}; Path=/; HttpOnly; SameSite=Lax`
    })
    response.end(body)
    return
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  const recoveryDownload = pathname === '/recovery.mp4'
  if (pathname !== `/${filename}` && !recoveryDownload) {
    response.writeHead(404).end()
    return
  }

  const authenticated = request.headers.cookie?.includes(sessionCookie)
    && request.headers.authorization === authorization
    && request.headers['x-download-nonce'] === downloadNonce
    && request.headers.referer === `http://127.0.0.1:${server.address().port}/page.html`
  if (!authenticated && !recoveryDownload) {
    response.writeHead(403, { 'Content-Length': '0', 'Cache-Control': 'no-store' }).end()
    return
  }
  if (authenticated) authenticatedMediaRequests += 1

  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `${recoveryDownload ? 'attachment' : 'inline'}; filename="${recoveryDownload ? 'recovery.mp4' : filename}"`,
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  let offset = 0
  let timer
  response.on('close', () => {
    if (timer) clearTimeout(timer)
  })
  const send = () => {
    if (response.destroyed || response.writableEnded) return
    if (offset >= body.length) {
      response.end()
      return
    }
    const next = Math.min(offset + 64 * 1024, body.length)
    response.write(body.subarray(offset, next))
    offset = next
    timer = setTimeout(send, 45)
  }
  send()
})

class HostClient {
  constructor(port = hostPort) {
    this.port = port
    this.nextId = 1
    this.pending = new Map()
    this.eventWaiters = new Set()
    this.buffer = ''
  }

  async connect() {
    this.socket = createConnection({ host: '127.0.0.1', port: this.port })
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk) => this.receive(chunk))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`NDMHost did not accept port ${this.port}`)), 5_000)
      this.socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  receive(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : null
      if (pending) {
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok === false) pending.reject(new Error(String(message.error ?? 'NDMHost request failed')))
        else pending.resolve(message)
        continue
      }
      for (const waiter of this.eventWaiters) {
        if (message.op !== waiter.op) continue
        this.eventWaiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    }
  }

  request(op, extra = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`NDMHost ${op} timed out`))
      }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ id, op, ...extra })}\n`)
    })
  }

  waitForEvent(op, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const waiter = { op, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.eventWaiters.delete(waiter)
        reject(new Error(`NDMHost event ${op} timed out`))
      }, timeoutMs)
      this.eventWaiters.add(waiter)
    })
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('NDMHost client closed'))
    }
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('NDMHost client closed'))
    }
    this.pending.clear()
    this.eventWaiters.clear()
    this.socket?.destroy()
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Relay QA server did not expose a TCP port')
const pageUrl = `http://127.0.0.1:${address.port}/page.html`
const mediaUrl = `http://127.0.0.1:${address.port}/${filename}`

const host = new HostClient()
let context
let popup
let electronApp
let electronWindow
let originalSettings
let hostConnected = false
const consoleErrors = []
const cleanupFailures = []

async function findTask() {
  const reply = await host.request('list')
  if (!Array.isArray(reply.tasks)) throw new Error('NDMHost list did not return a task array')
  return reply.tasks.find((item) => item.url === mediaUrl) ?? null
}

async function waitForTaskStatus(status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastTask = null
  while (Date.now() < deadline) {
    lastTask = await findTask()
    if (lastTask?.status === status) return lastTask
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error(`Relay task did not reach ${status}: ${JSON.stringify(lastTask)}`)
}

async function cleanupTask() {
  const task = await findTask()
  if (task) await host.request('remove', { taskID: task.id, deleteFile: true })
  if (await findTask()) throw new Error('Relay task still exists after cleanup')
  report.cleanupTaskAbsent = true
}

try {
  // Launch Electron first and connect to the fresh host that it owns.
  electronApp = await electron.launch({
    ...(appPath ? { executablePath: appPath } : {}),
    args: [...(appPath ? [] : ['.']), `--user-data-dir=${electronProfilePath}`],
    cwd: repositoryFileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NDM_HOST_PORT: String(hostPort),
      NDM_BRIDGE_PORT: String(bridgePort),
      NDM_DISABLE_LEGACY_BRIDGE: '1',
      NDM_SKIP_ONBOARDING: '1',
      NDM_SUPPORT_DIR: supportPath
    }
  })
  electronWindow = await electronApp.firstWindow()
  await electronApp.evaluate(({ ipcMain }) => {
    for (const channel of ['system:read-clipboard', 'system:clipboard-snapshot', 'system:write-clipboard']) ipcMain.removeHandler(channel)
    ipcMain.handle('system:read-clipboard', () => '')
    ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0 }))
    ipcMain.handle('system:write-clipboard', () => true)
  })
  electronWindow.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`electron: ${message.text()}`)
  })
  await electronWindow.waitForFunction(() => Boolean(window.ndm?.status), undefined, { timeout: 20_000 })
  await electronWindow.locator('.library-search').waitFor({ state: 'visible', timeout: 20000 })
  await electronWindow.getByRole('dialog', { name: '欢迎使用 NDM' }).waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  await completeOnboarding(electronWindow)

  // Wait for this app's isolated host, then attach.
  for (let i = 0; i < 40; i += 1) {
    const up = await new Promise((resolve) => {
      const probe = createConnection({ host: '127.0.0.1', port: hostPort })
      probe.once('connect', () => { probe.destroy(); resolve(true) })
      probe.once('error', () => resolve(false))
      setTimeout(() => { probe.destroy(); resolve(false) }, 500)
    })
    if (up) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await host.connect()
  hostConnected = true
  if ((await host.request('list')).tasks?.length) throw new Error('Isolated host did not start with an empty library')
  const settingsReply = await host.request('getSettings')
  originalSettings = settingsReply.settings
  await host.request('updateSettings', { downloadDirectory: downloads, maxConnections: 2 })

  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    ...(process.env.NDM_QA_BROWSER_PATH ? { executablePath: process.env.NDM_QA_BROWSER_PATH } : {}),
    headless: true,
    acceptDownloads: true,
    downloadsPath: `${qaRoot}/browser-downloads`,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  })
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
  const extensionId = new URL(worker.url()).host
  if (!extensionId) throw new Error(`Relay service worker has no extension id: ${worker.url()}`)

  const mediaPage = await context.newPage()
  mediaPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`page: ${message.text()}`)
  })
  await mediaPage.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const mediaTabId = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url === target)?.id ?? -1
  }, pageUrl)
  if (mediaTabId < 0) throw new Error('Relay could not locate the media tab')
  await mediaPage.evaluate(async ({ target, authorization, downloadNonce }) => {
    const response = await fetch(target, {
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Authorization: authorization,
        'X-Download-Nonce': downloadNonce
      }
    })
    if (!response.ok) throw new Error(`Authenticated Relay fixture failed: ${response.status}`)
    await response.arrayBuffer()
  }, { target: mediaUrl, authorization, downloadNonce })

  popup = await context.newPage()
  await popup.setViewportSize({ width: 360, height: 600 })
  popup.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`popup: ${message.text()}`)
  })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.locator('#status-text').waitFor({ state: 'visible' })
  await popup.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'connected', null, {
    timeout: 5_000
  })
  const versionText = await popup.locator('#foot-note').innerText()
  console.log('relay popup connected:', JSON.stringify({ extensionId, versionText }))

  const offlinePopup = await context.newPage()
  await offlinePopup.setViewportSize({ width: 360, height: 600 })
  // The extension now fails over between the contract port and the legacy
  // fallback, so a believable outage must black out both addresses.
  await offlinePopup.routeWebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, async (socket) => {
    await socket.close({ code: 1001, reason: 'Intentional Relay QA outage' })
  })
  await offlinePopup.goto(`chrome-extension://${extensionId}/popup.html`)
  // Rotation across both endpoints needs a few probe rounds; give the honest
  // offline verdict room to land.
  await offlinePopup.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'offline', null, {
    timeout: 12_000
  })
  if (await offlinePopup.locator('#offline-hint').isHidden()) throw new Error('Relay popup hid its offline explanation')
  const offlineHint = await offlinePopup.locator('#offline-hint').innerText()
  if (evidencePath) await offlinePopup.screenshot({ path: join(evidencePath, 'relay-offline.png') })
  await offlinePopup.close()
  await popup.reload()
  await popup.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'connected', null, {
    timeout: 5_000
  })
  console.log('relay popup recovery:', JSON.stringify({ offlineHint, recovered: true }))
  report.checks.popupOfflineAndRecovery = { passed: true, method: 'Injected WebSocket outage in an independent real extension popup', offlineHint }
  if (evidencePath) await popup.screenshot({ path: join(evidencePath, 'relay-connected.png') })
  await worker.evaluate(() => {
    globalThis.__qaPreviousSocket = NDM_BG.G
    NDM_BG.G.close(4001, 'Intentional Relay QA disconnect')
  })
  await new Promise(done => setTimeout(done, 100))
  await worker.evaluate(() => NDM_BG.requestAppFocus())
  let bridgeRecovered = false
  for (let i = 0; i < 80; i++) {
    bridgeRecovered = await worker.evaluate(() => Boolean(NDM_BG.D && NDM_BG.G?.readyState === 1 && NDM_BG.G !== globalThis.__qaPreviousSocket))
    if (bridgeRecovered) break
    await new Promise(done => setTimeout(done, 250))
  }
  if (!bridgeRecovered) throw new Error('Real extension worker did not reconnect to the isolated Swift bridge')
  report.checks.workerDisconnectAndReconnect = { passed: true, method: 'Closed real extension WebSocket; called existing requestAppFocus; observed a new connected WebSocket' }

  const focusEvent = host.waitForEvent('focusApp')
  await popup.locator('#open-app').click()
  await focusEvent
  console.log('relay app focus:', 'host broadcast received')

  let mediaState = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    mediaState = await worker.evaluate((tabId) => {
      let mediaCount = 0
      let mediaSample = null
      Object.values(NDM_BG.H).forEach((port) => {
        if (!port || port.tabId !== tabId) return
        mediaCount += Number(port.mediaCount || 0)
        if (port.mediaSample && (!mediaSample || port.ja)) mediaSample = port.mediaSample
      })
      return {
        connected: Boolean(NDM_BG.D),
        mediaCount,
        mediaSample,
        ports: Object.values(NDM_BG.H).map((port) => ({
          id: port?.id,
          tabId: port?.tabId,
          frameId: port?.frameId,
          mediaCount: Number(port?.mediaCount || 0)
        }))
      }
    }, mediaTabId)
    if (Number(mediaState?.mediaCount ?? 0) > 0) break
    await mediaPage.waitForTimeout(200)
  }
  if (Number(mediaState?.mediaCount ?? 0) < 1) {
    const controls = await mediaPage.locator('div[id^="neatDiv"]').count()
    throw new Error(`Relay did not identify the real MP4 response: ${JSON.stringify({ mediaState, controls })}`)
  }
  console.log('relay media recognition:', JSON.stringify(mediaState))

  await worker.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { active: true })
  }, mediaTabId)
  await popup.reload()
  await popup.locator('#media-card').waitFor({ state: 'visible', timeout: 5_000 })
  let mediaLine, candidateLabel
  if (mediaShelfMode) {
    mediaLine = await popup.locator('#page-title').innerText()
    const candidate = popup.locator('button.media-download').first()
    await candidate.waitFor({ state: 'visible', timeout: 5_000 })
    candidateLabel = (await candidate.getAttribute('aria-label')) ?? await candidate.innerText()
    report.candidateLabel = candidateLabel
    if (evidencePath) {
      await popup.locator('body').screenshot({ path: join(evidencePath, 'relay-media-popup.png') })
      report.toolbarLight = await inspectToolbar(context, worker, join(evidencePath, 'actual-toolbar-popup.png'))
      report.toolbarDark = await inspectToolbar(context, worker, join(evidencePath, 'actual-toolbar-popup-dark.png'), { dark: true })
      if (report.toolbarLight.innerWidth !== 360 || report.toolbarLight.scrollWidth !== 360 || report.toolbarLight.innerHeight > 600) {
        throw new Error('Actual toolbar popup is clipped or wrong width')
      }
    }
    if (await findTask()) throw new Error('Relay created a task before the user clicked a candidate')
    await mediaPage.goto(pageUrl + '?navigation=1', { waitUntil: 'domcontentloaded' })
    await candidate.click()
    await popup.locator('.media-feedback[data-state="error"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    const navigationFailure = await popup.locator('.media-feedback').first().innerText()
    if (!(await candidate.isEnabled())) throw new Error('Stale navigation candidate cannot be retried')
    if (await findTask()) throw new Error('Stale page selection created a task')
    if (evidencePath) await popup.locator('body').screenshot({ path: join(evidencePath, 'relay-navigation-retry.png') })
    report.checks.stalePageFailure = {
      passed: true, feedback: navigationFailure, taskNotCreated: true,
      method: 'Real source tab navigated after popup loaded; stale popup selection was rejected'
    }
    await mediaPage.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    await mediaPage.evaluate(async ({ target, authorization, downloadNonce }) => {
      const response = await fetch(target, {
        cache: 'no-store', credentials: 'include',
        headers: { Authorization: authorization, 'X-Download-Nonce': downloadNonce }
      })
      if (!response.ok) throw new Error('Fixture refresh failed ' + response.status)
      await response.arrayBuffer()
    }, { target: mediaUrl, authorization, downloadNonce })
    await worker.evaluate(async tabId => chrome.tabs.update(tabId, { active: true }), mediaTabId)
    await popup.locator('#refresh-page').click()
    await popup.locator('button.media-download').first().waitFor({ state: 'visible', timeout: 5_000 })
    await popup.locator('button.media-download').first().click()
    await popup.locator('.media-feedback[data-state="sent"]').first().waitFor({ state: 'visible', timeout: 12_000 })
    report.directPopupFeedback = await popup.locator('.media-feedback').first().innerText()
    if (evidencePath) await popup.locator('body').screenshot({ path: join(evidencePath, 'relay-popup-sent.png') })
  } else {
    mediaLine = await popup.locator('#media-count-line').innerText()
    if (await popup.locator('#show-panel').isVisible()) {
      await popup.locator('#show-panel').click()
    } else {
      // The new popup offers direct selection; exercise the retained page control.
      await popup.close()
      await mediaPage.locator('button.ndm-launcher').first().click()
    }

    const relayRoot = mediaPage.locator('div[id^="neatDiv"]')
    await relayRoot.waitFor({ state: 'attached', timeout: 5_000 })
    const candidate = relayRoot.locator('button.ndm-media-item').first()
    await candidate.waitFor({ state: 'visible', timeout: 5_000 })
    candidateLabel = (await candidate.getAttribute('aria-label')) ?? await candidate.innerText()
    report.candidateLabel = candidateLabel
    if (evidencePath) await mediaPage.screenshot({ path: join(evidencePath, 'relay-media-candidate.png') })
    if (await findTask()) throw new Error('Relay created a task before the user clicked a candidate')
    await candidate.click()
  }

  const completed = await waitForTaskStatus('complete', 30_000)
  await electronWindow.getByText(completed.filename, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  console.log('electron relay feedback:', 'task appeared in Electron app')

  if (completed.completedBytes !== payload.length || completed.fileSize !== payload.length) {
    throw new Error(`Relay download byte count is inconsistent: ${JSON.stringify(completed)}`)
  }
  console.log('relay task handoff:', JSON.stringify({ mediaLine, candidateLabel, bytes: completed.completedBytes }))
  if ((await host.request('list')).tasks.length !== 1) throw new Error('One media selection created multiple tasks')
  const finalPath = resolve(completed.folderPath, completed.filename)
  if (!finalPath.startsWith(`${downloads}/`)) throw new Error('Relay output escaped the isolated download directory')
  const actualSHA256 = sha256(readFileSync(finalPath))
  const expectedSHA256 = sha256(payload)
  if (actualSHA256 !== expectedSHA256) throw new Error('Downloaded MP4 SHA256 differs from source')
  const decode = spawnSync(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', finalPath, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 })
  if (decode.status !== 0) throw new Error(`Downloaded MP4 failed complete decode: ${decode.stderr}`)
  report.checks.authenticatedMediaHandoff = { passed: true, actualSHA256, expectedSHA256, bytes: completed.completedBytes, decodeExitCode: decode.status, authenticatedMediaRequests }
  if (evidencePath) {
    cpSync(finalPath, join(evidencePath, 'downloaded-fixture.mp4'))
    await electronWindow.screenshot({ path: join(evidencePath, 'electron-download-complete.png') })
  }
  if (authenticatedMediaRequests < 2) {
    throw new Error(`Relay did not replay the authenticated browser session: ${authenticatedMediaRequests} accepted requests`)
  }
  console.log('relay authenticated session:', `${authenticatedMediaRequests} accepted requests`)

  // The controller and Chrome download APIs are real. Only one resume call is
  // deliberately rejected to exercise this PR's automatic timeout recovery.
  const recovery = await worker.evaluate(async (url) => {
    const oldResume = chrome.downloads.resume.bind(chrome.downloads)
    const oldCatcher = NDM_BG.v
    NDM_BG.v = false
    globalThis.__qaRecovery = { attempts: 0, resumed: 0, oldResume, oldCatcher }
    chrome.downloads.resume = async (id) => {
      __qaRecovery.attempts++
      if (__qaRecovery.attempts === 1) throw new Error('Intentional one-shot QA downloads.resume failure')
      await oldResume(id)
      __qaRecovery.resumed++
    }
    const requestId = NDM_BG.browserHandoffs.begin(url)
    const downloadId = await chrome.downloads.download({ url, filename: 'recovery.mp4', saveAs: false })
    return { requestId, downloadId }
  }, `http://127.0.0.1:${address.port}/recovery.mp4`)
  let observedPaused = false
  let recoveryState
  for (let i = 0; i < 100; i++) {
    recoveryState = await worker.evaluate(async ({ requestId, downloadId }) => {
      const [download] = await chrome.downloads.search({ id: downloadId })
      const saved = await chrome.storage.session.get('ndmBrowserHandoffsV1')
      return { download, active: NDM_BG.browserHandoffs.active(requestId), attempts: __qaRecovery.attempts, resumed: __qaRecovery.resumed, savedCount: (saved.ndmBrowserHandoffsV1 || []).length }
    }, recovery)
    observedPaused ||= Boolean(recoveryState.download?.paused)
    if (recoveryState.download?.state === 'complete' && !recoveryState.active) break
    await new Promise(done => setTimeout(done, 200))
  }
  await worker.evaluate(() => { chrome.downloads.resume = __qaRecovery.oldResume; NDM_BG.v = __qaRecovery.oldCatcher })
  if (!observedPaused || recoveryState.attempts !== 2 || recoveryState.resumed !== 1 || recoveryState.active || recoveryState.download?.state !== 'complete' || recoveryState.savedCount !== 0) {
    throw new Error(`Real Chrome pause/resume fault recovery failed: ${JSON.stringify({ observedPaused, recoveryState })}`)
  }
  const recoverySHA256 = sha256(readFileSync(recoveryState.download.filename))
  if (recoverySHA256 !== expectedSHA256) throw new Error('Recovered browser download SHA256 differs from source')
  report.checks.browserPauseResumeFailure = { passed: true, observedPaused, attempts: recoveryState.attempts, successfulResumes: recoveryState.resumed, savedHandoffsRemaining: recoveryState.savedCount, actualSHA256: recoverySHA256, method: 'Real Chrome download and original handoff controller; begin called directly, first resume invocation injected to throw' }
  await worker.evaluate(async (id) => { await chrome.downloads.removeFile(id); await chrome.downloads.erase({ id }) }, recovery.downloadId)
  console.log('relay browser pause recovery:', JSON.stringify(report.checks.browserPauseResumeFailure))

  await cleanupTask()
  console.log('relay task cleanup:', await findTask() == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`browser console errors: ${consoleErrors.join(' | ')}`)
  report.passed = true
} catch (error) {
  report.failure = String(error?.stack || error)
  if (popup && !popup.isClosed()) {
    report.popupText = await popup.locator('body').innerText().catch(() => '')
    if (evidencePath) await popup.locator('body').screenshot({ path: join(evidencePath, 'failure-popup.png') }).catch(() => {})
  }
  if (evidencePath && electronWindow) {
    await electronWindow.screenshot({ path: join(evidencePath, 'failure-electron.png') }).catch(() => {})
    report.electronText = await electronWindow.locator('body').innerText().catch(() => '')
  }
  throw error
} finally {
  if (hostConnected) await cleanupTask().catch((error) => {
    cleanupFailures.push(`task cleanup: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (hostConnected && originalSettings?.downloadDirectory && originalSettings?.maxConnections) {
    await host.request('updateSettings', {
      downloadDirectory: originalSettings.downloadDirectory,
      maxConnections: originalSettings.maxConnections
    }).catch((error) => {
      cleanupFailures.push(`settings restore: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  await context?.close().catch((error) => {
    cleanupFailures.push(`Chromium close: ${error instanceof Error ? error.message : String(error)}`)
  })
  await electronApp?.close().catch((error) => {
    cleanupFailures.push(`Electron close: ${error instanceof Error ? error.message : String(error)}`)
  })
  host.close()
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  for (let attempt = 0; attempt < 50; attempt++) {
    report.cleanupPortsClosed = await Promise.all([hostPort, bridgePort].map(async port => !await portTaken(port)))
    if (report.cleanupPortsClosed.every(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!report.cleanupPortsClosed.every(Boolean)) cleanupFailures.push('Isolated host or bridge port remained open')
  try {
    if (!report.cleanupPortsClosed.every(Boolean)) throw new Error('Refusing preferences cleanup while the QA host may still write them')
    const exported = readOwnedDefaults()
    if (exported !== null) {
      const encoded = exported.match(/<key>AppSettingsJSON<\/key>\s*<data>([\s\S]*?)<\/data>/)?.[1]
      if (!encoded) throw new Error('QA suite has no AppSettingsJSON ownership evidence')
      const settings = JSON.parse(Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8'))
      if (settings.bridgePort !== bridgePort) throw new Error('QA suite bridge port does not match this run')
      if (![downloads, originalSettings?.downloadDirectory].includes(settings.downloadDirectory)) throw new Error('QA suite download directory does not match this run')
      const removed = spawnSync('/usr/bin/defaults', ['delete', defaultsSuite], { encoding: 'utf8' })
      if (removed.status !== 0) throw new Error(`Removing the exact QA suite failed (exit ${removed.status})`)
    }
    if (readOwnedDefaults() !== null) throw new Error('QA preference values remained after defaults deletion')
    // macOS may retain an empty plist after deleting the persistent domain.
    // It belongs to the suite proven absent before this run, so recycle it.
    if (existsSync(defaultsPlist)) {
      const trashed = spawnSync('/usr/bin/trash', [defaultsPlist], { encoding: 'utf8' })
      if (trashed.status !== 0) throw new Error('Unable to recycle the empty QA preferences plist')
    }
    report.cleanupPreferencesAbsent = readOwnedDefaults() === null && !existsSync(defaultsPlist)
    if (!report.cleanupPreferencesAbsent) throw new Error('QA preferences suite remained after removal')
  } catch (error) {
    cleanupFailures.push(`preferences cleanup: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (existsSync(qaRoot)) {
    const trashed = spawnSync('/usr/bin/trash', [qaRoot], { encoding: 'utf8' })
    if (trashed.status !== 0) {
      cleanupFailures.push(`Trash cleanup: ${trashed.stderr || trashed.stdout}`)
    }
  }
  report.cleanupFailures = cleanupFailures
  if (cleanupFailures.length || !report.cleanupPortsClosed.every(Boolean) || !report.cleanupPreferencesAbsent) report.passed = false
  if (evidencePath) writeFileSync(join(evidencePath, 'report.json'), JSON.stringify(report, null, 2))
  if (cleanupFailures.length) throw new Error(`Relay QA cleanup failed: ${cleanupFailures.join(' | ')}`)
}

console.log('DONE')
