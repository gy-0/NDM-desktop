import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filename = 'ndm-schedule-qa.bin'
const payload = Buffer.alloc(12 * 1024 * 1024, 0x73)
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
  const send = () => {
    if (offset >= body.length) {
      res.end()
      return
    }
    const next = Math.min(offset + 64 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    setTimeout(send, 80)
  }
  send()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')
const url = `http://127.0.0.1:${address.port}/${filename}`
const launchOptions = qaLaunchOptions('schedule')

let app
let win
const consoleErrors = []

async function waitForLive(window) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('暂无下载'),
    undefined,
    { timeout: 15_000 }
  )
  for (let i = 0; i < 60; i++) {
    if (await window.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') return
    await window.waitForTimeout(250)
  }
  throw new Error('engine did not become live')
}

async function task(window) {
  return await window.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).find((item) => item.filename === target) ?? null
  }, filename)
}

async function cleanup(window) {
  if (!window) return
  await window.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    const tasks = (reply?.tasks ?? []).filter((item) => item.filename === target)
    for (const item of tasks) {
      await window.ndm?.request('remove', { taskID: item.id, deleteFile: true })
    }
  }, filename).catch(() => {})
}

async function launch() {
  app = await electron.launch(launchOptions)
  win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await waitForLive(win)
  return win
}

try {
  await launch()
  const onboardingSteps = await completeOnboarding(win, { exerciseAllSteps: true })
  console.log('onboarding completed:', onboardingSteps)

  await win.keyboard.press('Meta+n')
  const urlInput = win.locator('input[placeholder*="下载链接"]')
  await urlInput.fill(url)
  await win.keyboard.press('Enter')
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'downloading')
  }, filename, { timeout: 10_000 })

  await win.getByRole('button', { name: '暂停下载' }).click()
  await win.waitForFunction(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target && item.status === 'paused')
  }, filename, { timeout: 10_000 })

  await win.locator('[data-hero-state]').getByText(filename, { exact: true }).click()
  const beforeSchedule = Date.now()
  await win.getByRole('button', { name: '1 小时后' }).click()
  await win.waitForFunction(async ({ target, earliest }) => {
    const reply = await window.ndm?.request('list')
    const item = (reply?.tasks ?? []).find((candidate) => candidate.filename === target)
    return item?.status === 'waiting' && item.startAt >= earliest
  }, { target: filename, earliest: beforeSchedule + 59 * 60 * 1000 }, { timeout: 10_000 })

  const scheduledBeforeRestart = await task(win)
  if (!scheduledBeforeRestart?.startAt) throw new Error('schedule did not reach the Host')
  if (!await win.getByText('定时开始', { exact: true }).first().isVisible()) {
    throw new Error('scheduled appointment is not visible in the inspector')
  }
  console.log('scheduled from UI:', JSON.stringify({
    status: scheduledBeforeRestart.status,
    startAt: scheduledBeforeRestart.startAt,
    delayMs: scheduledBeforeRestart.startAt - beforeSchedule
  }))

  await app.close()
  app = null
  win = null

  await launch()
  const scheduledAfterRestart = await task(win)
  if (scheduledAfterRestart?.status !== 'waiting' || scheduledAfterRestart.startAt !== scheduledBeforeRestart.startAt) {
    throw new Error(`schedule did not survive relaunch: ${JSON.stringify(scheduledAfterRestart)}`)
  }
  console.log('schedule survived relaunch:', scheduledAfterRestart.startAt)

  const dueAt = Date.now() + 1_500
  await win.evaluate(async ({ taskID, startAt }) => {
    await window.ndm?.request('schedule', { taskID, startAt })
  }, { taskID: scheduledAfterRestart.id, startAt: dueAt })

  const transitions = []
  let previousState = ''
  let startedAutomatically = false
  let stableCompleteSamples = 0
  for (let i = 0; i < 400; i++) {
    const current = await task(win)
    const state = JSON.stringify({
      status: current?.status ?? null,
      startAt: current?.startAt ?? null,
      completedBytes: current?.completedBytes ?? null,
      fileSize: current?.fileSize ?? null
    })
    if (state !== previousState) {
      transitions.push({ elapsedMs: Date.now() - dueAt + 1_500, ...JSON.parse(state) })
      previousState = state
    }
    if (current?.status === 'downloading' && current.startAt == null) startedAutomatically = true
    if (current?.status === 'complete' && current.fileSize > 0 && current.completedBytes === current.fileSize) {
      stableCompleteSamples += 1
      if (stableCompleteSamples >= 10) break
    } else {
      stableCompleteSamples = 0
    }
    await win.waitForTimeout(100)
  }
  console.log('schedule transitions:', JSON.stringify(transitions))
  if (!startedAutomatically) throw new Error('scheduled task never started automatically')
  console.log('scheduled task started automatically: true')

  const completedTask = await task(win)
  console.log('scheduled task final state:', JSON.stringify({
    status: completedTask?.status ?? null,
    completedBytes: completedTask?.completedBytes ?? null,
    fileSize: completedTask?.fileSize ?? null
  }))
  if (stableCompleteSamples < 10 || completedTask?.status !== 'complete' || completedTask.completedBytes !== completedTask.fileSize) {
    throw new Error(`scheduled task did not stay complete: ${JSON.stringify(completedTask)}`)
  }

  await cleanup(win)
  const remaining = await task(win)
  console.log('qa task cleanup:', remaining == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`)
} finally {
  await cleanup(win)
  await app?.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

console.log('DONE')
