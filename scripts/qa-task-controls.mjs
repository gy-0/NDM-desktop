import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

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
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await win.waitForFunction(
    () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('没有下载'),
    undefined,
    { timeout: 15_000 }
  )
  await completeOnboarding(win, { exerciseAllSteps: true })
  for (let i = 0; i < 60; i++) {
    if (await win.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') break
    if (i === 59) throw new Error('engine did not become live')
    await win.waitForTimeout(250)
  }

  await win.evaluate(async () => {
    await window.ndm?.request('updateSettings', { maxConnections: 4 })
  })
  await win.keyboard.press('Meta+n')
  await win.locator('input[placeholder*="下载链接"]').fill(url)
  await win.keyboard.press('Enter')
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) =>
      item.filename === target && item.status === 'downloading' && item.connections === 4 && item.segments?.length >= 4
    )
  }, filename, { timeout: 15_000 })

  await win.getByRole('button', { name: '减少连接' }).waitFor({ state: 'visible' })
  await win.getByRole('button', { name: '减少连接' }).click()
  await win.getByRole('button', { name: '减少连接' }).click()
  await win.waitForFunction(async (target) => {
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
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.bandwidthLimit === 1_048_576)
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '暂停下载' }).click()
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'paused')
  }, filename, { timeout: 10_000 })
  const taskRow = win.locator('li').filter({ hasText: filename }).first()
  await taskRow.hover()
  await win.waitForTimeout(150)
  await taskRow.getByRole('button', { name: '继续' }).click()
  await win.waitForFunction(async (target) => {
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
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'paused')
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '不限速' }).click()
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.bandwidthLimit === 0)
  }, filename, { timeout: 10_000 })
  await win.getByRole('button', { name: '增加连接' }).click()
  await win.getByRole('button', { name: '增加连接' }).click()
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.connections === 4)
  }, filename, { timeout: 10_000 })
  await taskRow.hover()
  await win.waitForTimeout(150)
  await taskRow.getByRole('button', { name: '继续' }).click()
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) =>
      item.filename === target && item.status === 'complete' && item.completedBytes === item.fileSize
    )
  }, filename, { timeout: 30_000 })
  console.log('unlimited resume completed:', true)

  await cleanup()
  console.log('qa task cleanup:', await task() == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`)
} finally {
  await cleanup()
  await app?.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

console.log('DONE')
