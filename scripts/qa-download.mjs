import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

// Throttled, range-aware server so QA observes a real transferring -> complete transition.
const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a)
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

const app = await electron.launch({ args: ['.'], cwd: '/Users/gaoyuan/NDM-desktop' })
const win = await app.firstWindow()
const errors = []
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await win.waitForSelector('ul li', { timeout: 15000 })
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

// 3) real end-to-end download via composer
await win.keyboard.press('Meta+n')
await win.waitForTimeout(600)
const urlInput = win.locator('input[placeholder*="下载链接"]')
await urlInput.fill('')
await urlInput.pressSequentially('http://127.0.0.1:8123/ndm-qa-test.bin', { delay: 5 })
await win.waitForTimeout(300)
await win.keyboard.press('Enter')

await win.waitForFunction(
  () => [...document.querySelectorAll('section')].some((section) => section.textContent?.includes('ndm-qa-test') && section.textContent.includes('个连接')),
  undefined,
  { timeout: 5_000 }
)
const activeVisual = await win.evaluate(() => {
  const hero = [...document.querySelectorAll('section')].find((section) => section.textContent?.includes('ndm-qa-test') && section.textContent.includes('个连接'))
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
await app.close()
server.close()
console.log('DONE')
