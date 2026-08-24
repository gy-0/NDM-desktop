import { _electron as electron, chromium } from 'playwright'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const appPath = process.env.NDM_QA_APP_PATH?.trim()
if (!appPath) throw new Error('NDM_QA_APP_PATH must point to the packaged NDM executable')

// Preflight: this QA drives the DEFAULT host/bridge ports because the packaged
// extension dials ws://127.0.0.1:51873 by contract. If any process already
// listens there it is almost certainly the user's real NDM — abort instead of
// mutating a production settings store and library.
async function portTaken(port) {
  return new Promise((resolve) => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
    setTimeout(() => { probe.destroy(); resolve(false) }, 800)
  })
}
if (await portTaken(51_874)) {
  throw new Error('Port 51874 is busy — quit the running NDM first; this QA must not touch a live instance')
}
if (await portTaken(51_873)) {
  throw new Error('Port 51873 (Relay bridge) is busy — quit the running NDM first')
}
const contentsPath = appPath.replace(/\/Contents\/MacOS\/[^/]+$/, '/Contents')
const extensionPath = `${contentsPath}/Resources/extension/NDMRelay`
const ffmpegPath = `${contentsPath}/Resources/Tools/ffmpeg`
if (!existsSync(`${extensionPath}/manifest.json`)) {
  throw new Error(`packaged Relay is missing: ${extensionPath}`)
}
if (!existsSync(ffmpegPath)) throw new Error(`packaged ffmpeg is missing: ${ffmpegPath}`)

const qaRoot = `/tmp/ndm-relay-browser-qa-${process.pid}`
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
  if (pathname !== `/${filename}`) {
    response.writeHead(404).end()
    return
  }

  const authenticated = request.headers.cookie?.includes(sessionCookie)
    && request.headers.authorization === authorization
    && request.headers['x-download-nonce'] === downloadNonce
    && request.headers.referer === `http://127.0.0.1:${server.address().port}/page.html`
  if (!authenticated) {
    response.writeHead(403, { 'Content-Length': '0', 'Cache-Control': 'no-store' }).end()
    return
  }
  authenticatedMediaRequests += 1

  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `inline; filename="${filename}"`,
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
  constructor(port = 51_874) {
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
let electronApp
let electronWindow
let originalSettings
let hostConnected = false
const consoleErrors = []
const cleanupFailures = []

async function findTask() {
  const reply = await host.request('list')
  return (reply.tasks ?? []).find((item) => item.url === mediaUrl) ?? null
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
  const task = await findTask().catch(() => null)
  if (task) await host.request('remove', { taskID: task.id, deleteFile: true })
}

try {
  // Launch the app FIRST so its own NDMHost (spawned with the isolated
  // NDM_SUPPORT_DIR below) becomes the thing listening on the default ports.
  // The QA then attaches to that fresh, disposable host — never to whatever
  // production instance might have been running before.
  electronApp = await electron.launch({
    executablePath: appPath,
    args: [`--user-data-dir=${electronProfilePath}`],
    cwd: '/Users/gaoyuan/NDM-desktop',
    env: {
      ...process.env,
      NDM_HOST_PORT: '51874',
      // The extension dials the contract port by name; binding an ephemeral
      // bridge (0) is unusable in QA and in production alike.
      NDM_BRIDGE_PORT: '51873',
      NDM_SUPPORT_DIR: `${qaRoot}/unused-engine`
    }
  })
  electronWindow = await electronApp.firstWindow()
  electronWindow.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`electron: ${message.text()}`)
  })
  await electronWindow.waitForFunction(
    () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('没有下载'),
    undefined,
    { timeout: 20_000 }
  )
  const onboarding = electronWindow.getByRole('dialog', { name: '欢迎使用 NDM' })
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '跳过' }).click()
  }

  // The spawned host owns the default ports now — wait for it, then attach.
  for (let i = 0; i < 40; i += 1) {
    const up = await new Promise((resolve) => {
      const probe = createConnection({ host: '127.0.0.1', port: 51_874 })
      probe.once('connect', () => { probe.destroy(); resolve(true) })
      probe.once('error', () => resolve(false))
      setTimeout(() => { probe.destroy(); resolve(false) }, 500)
    })
    if (up) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await host.connect()
  hostConnected = true
  const settingsReply = await host.request('getSettings')
  originalSettings = settingsReply.settings
  await host.request('updateSettings', { downloadDirectory: downloads, maxConnections: 2 })

  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
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

  const popup = await context.newPage()
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
  // The extension now fails over between the contract port and the legacy
  // fallback, so a believable outage must black out both addresses.
  await offlinePopup.routeWebSocket(/ws:\/\/127\.0\.0\.1:(51873|10007)\/ndm\/download/, async (socket) => {
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
  await offlinePopup.close()
  await popup.reload()
  await popup.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'connected', null, {
    timeout: 5_000
  })
  console.log('relay popup recovery:', JSON.stringify({ offlineHint, recovered: true }))

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
  const mediaLine = await popup.locator('#media-count-line').innerText()
  await popup.locator('#show-panel').click()

  const relayRoot = mediaPage.locator('div[id^="neatDiv"]')
  await relayRoot.waitFor({ state: 'attached', timeout: 5_000 })
  const relayButtons = relayRoot.locator('button')
  if (await relayButtons.count() < 3) throw new Error('Relay media control did not expose a candidate action')
  const candidate = relayButtons.nth(1)
  await candidate.waitFor({ state: 'visible', timeout: 5_000 })
  const candidateLabel = (await candidate.getAttribute('aria-label')) ?? await candidate.innerText()
  if (await findTask()) throw new Error('Relay created a task before the user clicked a candidate')
  await candidate.click()

  await electronWindow.getByText(filename, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  console.log('electron relay feedback:', 'task appeared in packaged app')

  const completed = await waitForTaskStatus('complete', 30_000)
  if (completed.completedBytes !== payload.length || completed.fileSize !== payload.length) {
    throw new Error(`Relay download byte count is inconsistent: ${JSON.stringify(completed)}`)
  }
  console.log('relay task handoff:', JSON.stringify({ mediaLine, candidateLabel, bytes: completed.completedBytes }))
  if (authenticatedMediaRequests < 2) {
    throw new Error(`Relay did not replay the authenticated browser session: ${authenticatedMediaRequests} accepted requests`)
  }
  console.log('relay authenticated session:', `${authenticatedMediaRequests} accepted requests`)

  await cleanupTask()
  console.log('relay task cleanup:', await findTask() == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`browser console errors: ${consoleErrors.join(' | ')}`)
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
  await context?.close().catch(() => {})
  await electronApp?.close().catch((error) => {
    cleanupFailures.push(`Electron close: ${error instanceof Error ? error.message : String(error)}`)
  })
  host.close()
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  if (existsSync(qaRoot)) {
    const trashed = spawnSync('/usr/bin/trash', [qaRoot], { encoding: 'utf8' })
    if (trashed.status !== 0) {
      cleanupFailures.push(`Trash cleanup: ${trashed.stderr || trashed.stdout}`)
    }
  }
  if (cleanupFailures.length) throw new Error(`Relay QA cleanup failed: ${cleanupFailures.join(' | ')}`)
}

console.log('DONE')
