import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

// Throttled, range-aware server so QA observes a real transferring -> complete transition.
const payload = Buffer.alloc(64 * 1024 * 1024, 0x5a)
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
    setTimeout(send, 150)
  }
  send()
})
await new Promise((r) => server.listen(8123, '127.0.0.1', r))

const app = await electron.launch(qaLaunchOptions('download'))
let win
try {
win = await app.firstWindow()
const errors = []
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await win.waitForFunction(
  () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('没有下载'),
  undefined,
  { timeout: 15_000 }
)

// Exercise the real first-run boundary instead of assuming a warm profile.
// The app intentionally gives onboarding ownership of keyboard shortcuts.
const onboardingSteps = await completeOnboarding(win, { exerciseAllSteps: true })
console.log('onboarding completed:', onboardingSteps)

for (let i = 0; i < 60; i++) {
  if (await win.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') break
  if (i === 59) throw new Error('engine did not become live')
  await win.waitForTimeout(250)
}
await win.waitForTimeout(1500)

const staleCleanup = await win.evaluate(async () => {
  const before = await window.ndm?.request('list')
  const targets = (before?.tasks ?? []).filter((task) => String(task.filename).includes('ndm-qa-test'))
  for (const task of targets) {
    await window.ndm?.request('remove', { taskID: task.id, deleteFile: true })
  }
  return targets.map((task) => task.id)
})
console.log('stale qa tasks removed:', JSON.stringify(staleCleanup))

// 1) paused task inspector must NOT show the red errorText box
const pausedBox = await win.evaluate(() => {
  const aside = document.querySelectorAll('aside')[1] // inspector is 2nd aside
  return aside ? aside.innerText.includes('Download paused') : false
})
console.log('paused red box gone:', !pausedBox)

// 2) drag regions present
const dragRegions = await win.evaluate(() => {
  const check = (el) => el && getComputedStyle(el).webkitAppRegion === 'drag'
  const sidebarStrip = document.querySelector('aside > span[aria-hidden]')
  const header = document.querySelector('header')
  return { sidebar: check(sidebarStrip), header: check(header) }
})
console.log('drag regions:', JSON.stringify(dragRegions))

await win.evaluate(() => {
  window.__ndmQaEvents = []
  localStorage.setItem('ndm-progress-style', 'segmented')
  window.dispatchEvent(new CustomEvent('ndm-progress-style-change', { detail: 'segmented' }))
  window.ndm?.onEvent((message) => {
    if (message.op === 'snapshot') window.__ndmQaEvents.push(message)
  })
})

// 3) real end-to-end download via composer
await win.keyboard.press('Meta+n')
await win.waitForTimeout(600)
const urlInput = win.locator('input[placeholder*="下载链接"]')
await urlInput.fill('')
await urlInput.pressSequentially('http://127.0.0.1:8123/ndm-qa-test.bin', { delay: 5 })
await win.waitForTimeout(300)
await win.keyboard.press('Enter')

await win.waitForFunction(
  () => document.body.innerText.includes('ndm-qa-test.bin'),
  undefined,
  { timeout: 10_000 }
)
let transferring = false
for (let i = 0; i < 60; i++) {
  transferring = await win.evaluate(async () => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) =>
      String(item.filename).includes('ndm-qa-test') && item.status === 'downloading'
    )
  })
  if (transferring) break
  await win.waitForTimeout(250)
}
if (!transferring) throw new Error('download never entered transferring state')
let observedSegments = false
for (let i = 0; i < 60; i++) {
  observedSegments = await win.evaluate(async () => {
    const reply = await window.ndm?.request('list')
    const task = (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-qa-test'))
    return (task?.segments?.length ?? 0) > 1
  })
  if (observedSegments) break
  await win.waitForTimeout(250)
}
if (!observedSegments) throw new Error('engine never exposed a real multi-segment plan')
const directAfterSegments = await win.evaluate(async () => {
  const reply = await window.ndm?.request('list')
  return (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-qa-test'))
})
console.log('direct progress after segment wait:', JSON.stringify(directAfterSegments))
try {
  await win.waitForSelector('[data-progress-style="segmented"]', { timeout: 5_000 })
} catch (error) {
  const diagnostics = await win.evaluate(() => ({
    eventCount: window.__ndmQaEvents?.length ?? 0,
    eventStates: window.__ndmQaEvents?.map((event) => {
      const task = event.tasks?.find((item) => String(item.filename).includes('ndm-qa-test'))
      return task ? `${task.status}:${task.segments?.length ?? 0}:${task.completedBytes ?? 0}` : 'missing'
    }),
    lastEvent: window.__ndmQaEvents?.at(-1),
    body: document.body.innerText.slice(0, 1_000)
  }))
  throw new Error(`renderer missed live progress: ${JSON.stringify(diagnostics)}`, { cause: error })
}
const engineProgress = await win.evaluate(async () => {
  const reply = await window.ndm?.request('list')
  const task = (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-qa-test'))
  return { segments: task?.segments?.length ?? 0, connections: task?.connections ?? 0 }
})
const visibleProgress = await win.evaluate(() => {
  const track = document.querySelector('[role="progressbar"]')
  return {
    tracks: document.querySelectorAll('[role="progressbar"]').length,
    parts: track?.children.length ?? 0,
    label: track?.getAttribute('aria-label') ?? '',
    style: track?.getAttribute('data-progress-style') ?? '',
    heroText: [...document.querySelectorAll('main > section')].map((section) => section.textContent?.slice(0, 120))
  }
})
if (visibleProgress.tracks === 0) throw new Error(`active progress missing: ${JSON.stringify({ engineProgress, visibleProgress })}`)
if (visibleProgress.style !== 'segmented' || visibleProgress.parts !== engineProgress.segments) {
  throw new Error(`segmented progress is not truthful: ${JSON.stringify({ engineProgress, visibleProgress })}`)
}
await win.evaluate(() => {
  localStorage.setItem('ndm-progress-style', 'continuous')
  window.dispatchEvent(new CustomEvent('ndm-progress-style-change', { detail: 'continuous' }))
})
await win.waitForSelector('[data-progress-style="continuous"]')
const continuousParts = await win.locator('[data-progress-style="continuous"]').evaluate((track) => track.children.length)
console.log('progress modes:', JSON.stringify({ engineProgress, visibleProgress, continuousParts }))
const activeVisual = await win.evaluate(() => {
  const hero = [...document.querySelectorAll('section')].find((section) => section.textContent?.includes('ndm-qa-test'))
  const connectionRail = hero ? [...hero.querySelectorAll('div')].find((element) => element.textContent === '' && element.className.includes('h-1.5')) : null
  return {
    heroHeight: hero?.getBoundingClientRect().height ?? 0,
    connectionRailHeight: connectionRail?.getBoundingClientRect().height ?? 0
  }
})
console.log('active visual:', JSON.stringify(activeVisual))
const activeB64 = await app.evaluate(async ({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0]
  return (await window.capturePage()).toPNG().toString('base64')
})
writeFileSync('/tmp/ndm-shot-active-redesign.png', Buffer.from(activeB64, 'base64'))

// 4) exercise the actual pause/resume controls against the live Swift task.
await win.getByRole('button', { name: '暂停下载' }).click()
await win.waitForFunction(async () => {
  const reply = await window.ndm?.request('list')
  return (reply?.tasks ?? []).some((task) => String(task.filename).includes('ndm-qa-test') && task.status === 'paused')
}, undefined, { timeout: 10_000 })
const pausedProgress = await win.evaluate(async () => {
  const reply = await window.ndm?.request('list')
  const task = (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-qa-test'))
  return task?.completedBytes ?? -1
})
await win.waitForTimeout(700)
const pausedStableProgress = await win.evaluate(async () => {
  const reply = await window.ndm?.request('list')
  const task = (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-qa-test'))
  return task?.completedBytes ?? -1
})
if (pausedProgress < 0 || pausedStableProgress !== pausedProgress) {
  throw new Error(`paused task kept advancing: ${JSON.stringify({ pausedProgress, pausedStableProgress })}`)
}

const pausedTaskRow = win.locator('li').filter({ hasText: 'ndm-qa-test.bin' }).first()
await pausedTaskRow.getByRole('button', { name: '继续' }).click()
await win.waitForFunction(async (before) => {
  const reply = await window.ndm?.request('list')
  return (reply?.tasks ?? []).some((task) =>
    String(task.filename).includes('ndm-qa-test') && task.status === 'downloading' && task.completedBytes > before
  )
}, pausedProgress, { timeout: 10_000 })
console.log('pause/resume:', JSON.stringify({ pausedProgress, pausedStableProgress, resumed: true }))

// wait for the task to appear and complete
let done = false
let taskInfo = null
let completionAnimated = false
for (let i = 0; i < 400; i++) {
  await win.waitForTimeout(100)
  taskInfo = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('ul li')]
    const row = rows.find((r) => r.textContent.includes('ndm-qa-test'))
    return row ? row.textContent.slice(0, 120) : null
  })
  completionAnimated ||= (await win.locator('.task-complete-arrival').count()) > 0
  if (taskInfo && (taskInfo.includes('完成') || taskInfo.includes('失败'))) { done = true; break }
}
console.log('download row:', JSON.stringify(taskInfo))
console.log('download completed:', done && taskInfo.includes('完成'))
console.log('completion animation observed:', completionAnimated)

const b64 = await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  const img = await w.capturePage()
  const [cw, ch] = w.getContentSize()
  return img.resize({ width: cw, height: ch, quality: 'best' }).toPNG().toString('base64')
})
writeFileSync('/tmp/ndm-shot-5-download.png', Buffer.from(b64, 'base64'))

// cleanup: remove the QA task from the engine store (and trash the file)
const cleanup = await win.evaluate(async () => {
  const before = await window.ndm?.request('list')
  const targets = (before?.tasks ?? []).filter((task) => String(task.filename).includes('ndm-qa-test'))
  for (const task of targets) {
    await window.ndm?.request('remove', { taskID: task.id, deleteFile: true })
  }
  const after = await window.ndm?.request('list')
  return {
    removed: targets.map((task) => task.id),
    remaining: (after?.tasks ?? []).filter((task) => String(task.filename).includes('ndm-qa-test')).length
  }
})
console.log('qa task cleanup:', JSON.stringify(cleanup))
console.log('console errors:', errors.length ? errors.join(' | ') : 'none')
} finally {
  if (win) {
    await win.evaluate(async () => {
      const before = await window.ndm?.request('list')
      const targets = (before?.tasks ?? []).filter((task) => String(task.filename).includes('ndm-qa-test'))
      for (const task of targets) {
        await window.ndm?.request('remove', { taskID: task.id, deleteFile: true })
      }
    }).catch(() => {})
  }
  await app.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}
console.log('DONE')
process.exit(0)
