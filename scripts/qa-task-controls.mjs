import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { captureQAScreenshot, captureQAWindowVariants, closeQAApp, completeOnboarding, isolateQAClipboard, openDownloadSettings, qaLaunchOptions, waitForAsyncState } from './qa-env.mjs'

const filename = 'ndm-task-controls-qa.bin'
const payload = Buffer.alloc(64 * 1024 * 1024, 0x63)
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    'ETag': '"ndm-task-controls-fixed-payload-v1"',
    ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  let offset = 0
  let sendTimer
  res.on('close', () => {
    if (sendTimer) clearTimeout(sendTimer)
  })
  const send = () => {
    if (res.destroyed || res.writableEnded) return
    if (offset >= body.length) {
      res.end()
      return
    }
    const next = Math.min(offset + 64 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    sendTimer = setTimeout(send, 75)
  }
  send()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')
const url = `http://127.0.0.1:${address.port}/${filename}`
const launchOptions = qaLaunchOptions('task-controls')
const supportRoot = launchOptions.env.NDM_SUPPORT_DIR
const downloadDirectory = `${supportRoot}/downloads`
mkdirSync(downloadDirectory, { recursive: true })

let app
let win
const consoleErrors = []

async function task() {
  return await win.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).find((item) => item.filename === target) ?? null
  }, filename)
}

async function cleanup() {
  if (!win) return
  await win.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    const targets = (reply?.tasks ?? []).filter((item) => item.filename === target)
    for (const item of targets) {
      await window.ndm?.request('remove', { taskID: item.id, deleteFile: true })
    }
  }, filename).catch(() => {})
}

try {
  app = await electron.launch(launchOptions)
  win = await app.firstWindow()
  await isolateQAClipboard(app)
  win.setDefaultTimeout(8000)
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', { name: /添加下载/ }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await completeOnboarding(win, { exerciseAllSteps: true })
  for (let i = 0; i < 60; i++) {
    if (await win.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') break
    if (i === 59) throw new Error('engine did not become live')
    await win.waitForTimeout(250)
  }

  await win.evaluate(async (downloadDirectory) => {
    await window.ndm?.request('updateSettings', { maxConnections: 4, downloadDirectory })
  }, downloadDirectory)
  const composerInput = win.getByRole('textbox', { name: '下载链接', exact: true })
  if (!await composerInput.isVisible()) await win.keyboard.press('Meta+n')
  await composerInput.fill(url)
  if (process.env.NDM_QA_DIRECT_ADD === '1') {
    await win.keyboard.press('Escape')
    await win.evaluate(async (url) => {
      const reply = await window.ndm.request('add', { url })
      if (!reply.ok) throw new Error(reply.error || 'host rejected the file')
    }, url)
    await win.locator('[data-task-select]').filter({ hasNot: win.locator('[disabled]') }).first().click()
    console.log('creation path: real-host-ipc (OS Keychain approval excluded)')
  } else {
    await win.keyboard.press('Enter')
  }
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) =>
      item.filename === target && item.status === 'downloading' && item.connections === 4 && item.segments?.length >= 4
    )
  }, filename, { timeout: 15_000 })

  // Connection and speed controls live behind the pane's 下载设置 disclosure.
  await openDownloadSettings(win)
  await win.getByRole('button', { name: '减少连接' }).waitFor({ state: 'visible' })
  await win.getByRole('button', { name: '减少连接' }).click()
  await win.getByRole('button', { name: '减少连接' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.connections === 2)
  }, filename, { timeout: 10_000 })
  const replanned = await task()
  const logPath = `${supportRoot}/${replanned.id}/LogFile.txt`
  let engineLog = ''
  for (let i = 0; i < 50; i++) {
    try {
      engineLog = readFileSync(logPath, 'utf8')
    } catch {
      engineLog = ''
    }
    if (engineLog.includes('applyConnectionsCount: 2')) break
    await win.waitForTimeout(100)
  }
  if (!engineLog.includes('applyConnectionsCount: 2')) {
    throw new Error('connection change reached persistence but not the live Swift engine')
  }
  console.log('live connection replan:', JSON.stringify({
    connections: replanned.connections,
    segmentCount: replanned.segments.length,
    engineLogConfirmed: true
  }))

  await win.getByRole('button', { name: '1 MB/s' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.bandwidthLimit === 1_048_576)
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '暂停下载' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'paused')
  }, filename, { timeout: 10_000 })
  await captureQAWindowVariants(app, win, 'paused')
  await captureQAScreenshot(win, 'real-packaged-paused')
  await win.getByRole('button', { name: '继续下载' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'downloading')
  }, filename, { timeout: 10_000 })

  await win.waitForTimeout(1_200)
  const limitedStart = await task()
  const sampleStartedAt = Date.now()
  await win.waitForTimeout(3_200)
  const limitedEnd = await task()
  const elapsedSeconds = (Date.now() - sampleStartedAt) / 1000
  const observedBytesPerSecond = (limitedEnd.completedBytes - limitedStart.completedBytes) / elapsedSeconds
  console.log('per-task bandwidth sample:', JSON.stringify({
    elapsedSeconds,
    bytes: limitedEnd.completedBytes - limitedStart.completedBytes,
    observedBytesPerSecond
  }))
  if (observedBytesPerSecond <= 0 || observedBytesPerSecond > 1_450_000) {
    throw new Error(`1 MB/s task limit was not enforced: ${observedBytesPerSecond}`)
  }

  await win.getByRole('button', { name: '暂停下载' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'paused')
  }, filename, { timeout: 10_000 })
  await openDownloadSettings(win)
  await win.getByRole('button', { name: '跟随全局' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.bandwidthLimit === 0)
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '增加连接' }).click()
  await win.getByRole('button', { name: '增加连接' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.connections === 4)
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '继续下载' }).click()
  await waitForAsyncState(win, async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) =>
      item.filename === target && item.status === 'complete' && item.completedBytes === item.fileSize
    )
  }, filename, { timeout: 30_000 })
  const completedTask = await task()
  console.log('completion snapshot:', JSON.stringify({ task: completedTask, files: readdirSync(downloadDirectory) }))
  const finalBytes = readFileSync(join(completedTask.folderPath, completedTask.filename))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const sha256 = digest(finalBytes)
  if (finalBytes.length !== payload.length || sha256 !== digest(payload)) {
    throw new Error('The resumed task completed with mismatched file bytes')
  }
  console.log('unlimited resume completed:', JSON.stringify({ bytes: finalBytes.length, sha256 }))

  await win.waitForTimeout(900)
  const completionFeedback = await win.evaluate(() => ({ library: document.querySelectorAll('[data-completion-feedback="library"]').length, toast: document.querySelectorAll('[data-testid="completion-bar"]').length }))
  if (completionFeedback.library && completionFeedback.toast) throw new Error('Duplicate completion feedback')
  const artwork = await win.evaluate(async (path) => {
    const result = await window.ndm.loadFileThumbnail(path)
    const data = typeof result === 'string' ? result : result?.dataURL
    if (!data) return { missing: true, resultKeys: Object.keys(result ?? {}) }
    const img = new Image()
    img.src = data
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 16) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    return { width: img.naturalWidth, height: img.naturalHeight, contentWidth: right - left + 1, contentHeight: bottom - top + 1 }

  }, join(completedTask.folderPath, completedTask.filename))
  if (artwork.missing || Math.max(artwork.width, artwork.height) < 144 || artwork.contentHeight < artwork.height * 0.5) throw new Error(`Low density artwork: ${JSON.stringify(artwork)}`)
  console.log('native thumbnail dimensions:', JSON.stringify(artwork))
  console.log('completion feedback:', JSON.stringify(completionFeedback))
  await captureQAScreenshot(win, 'real-packaged-resumed-complete')
  await captureQAWindowVariants(app, win, 'complete')
  await cleanup()
  console.log('qa task cleanup:', await task() == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`)
} catch (error) {
  console.error(error)
  throw error
} finally {
  await cleanup()
  await closeQAApp(app)
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

console.log('DONE')
