// Actual Electron zoom, isolated support directory, synthetic snapshots only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const output = process.env.NDM_QA_OUTPUT || `/tmp/ndm-hero-zoom-${process.pid}`
await mkdir(output, { recursive: true })
const app = await electron.launch(qaLaunchOptions('hero-zoom'))
const results = [], errors = []
try {
  const win = await app.firstWindow()
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm?.status().catch(() => 'down') === 'live')
  const base = { folderPath: '/qa/Downloads', url: 'https://fixture.invalid/file.bin', source: 'fixture.invalid',
    category: 'misc', connections: 8, fileSize: 100 * 1024 ** 2, completedBytes: 20 * 1024 ** 2,
    bytesPerSecond: 8 * 1024 ** 2, status: 'downloading', phase: 'transferring', segments: [] }
  const tasks = [{ ...base, id: 902771, filename: 'Hero download with a deliberately long filename.bin', title: '', activityAt: 9999999999999 },
    { ...base, id: 902772, filename: 'Inspector target.bin', title: '' }]
  await app.evaluate(({ ipcMain, BrowserWindow }, tasks) => {
    globalThis.__heroQATasks = tasks; globalThis.__heroQAOps = []
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel === 'engine:event' && args[0]?.op === 'snapshot') args[0] = { ...args[0], tasks: globalThis.__heroQATasks }
      return send(channel, ...args)
    }
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_event, op, extra = {}) => {
      if (op === 'list') return { tasks: globalThis.__heroQATasks }
      if (op === 'pause' || op === 'resume') {
        globalThis.__heroQAOps.push({ op, taskID: extra.taskID })
        globalThis.__heroQATasks = globalThis.__heroQATasks.map(task => task.id === extra.taskID ? { ...task, status: op === 'pause' ? 'paused' : 'downloading' } : task)
        BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: globalThis.__heroQATasks })
      }
      return { ok: true }
    })
  }, tasks)
  const push = () => app.evaluate(({ BrowserWindow }, tasks) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks }), tasks)
  for (let attempt = 0; attempt < 15; attempt++) {
    await push()
    if (await win.locator('[data-task-select="902772"]').count()) break
    await win.waitForTimeout(120)
  }
  await win.locator('[data-task-select="902772"]').click()
  await win.locator('#task-inspector').waitFor()
  for (const width of [920, 1024, 1440]) for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(width, 900)
      window.webContents.setZoomFactor(zoom)
    }, { width, zoom })
    await push()
    await win.waitForTimeout(350)
    if (!await win.locator('#task-inspector').isVisible()) await win.locator('[data-task-select="902772"]').click()
    await win.locator('#task-inspector').waitFor()
    await win.waitForTimeout(180)
    assert.equal(await win.locator('#task-inspector').isVisible(), true)
    const geometry = await win.evaluate(() => {
      const hero = document.querySelector('[data-hero-state]'), main = document.querySelector('#main-content')
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
      const title = hero.querySelector('h1'), speed = hero.querySelector('[data-hero-speed]'), button = hero.querySelector('button[aria-label="暂停下载"]')
      const unit = speed.querySelector('span:last-child')
      const nodes = { title: rect(title), speed: rect(speed), unit: rect(unit), button: rect(button) }
      const bounds = rect(main)
      const outside = Object.entries(nodes).filter(([, r]) => r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1).map(([name]) => name)
      const overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
      return { main: bounds, nodes, outside, overlapping: overlap(nodes.title, nodes.speed) || overlap(nodes.title, nodes.button) || overlap(nodes.speed, nodes.button), viewport: innerWidth, detailsVisible: Boolean(document.querySelector('#task-inspector')) }
    })
    results.push({ width, zoom, ...geometry })
    console.log(JSON.stringify(results.at(-1)))
    if (width === 920 && zoom === 1.25) {
      const capture = await app.evaluate(async ({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0], image = await window.capturePage()
        return { png: image.toPNG().toString('base64'), size: image.getSize(), scale: image.getScaleFactors(), deviceScale: screen.getDisplayMatching(window.getBounds()).scaleFactor, bounds: window.getContentBounds() }
      })
      const png = Buffer.from(capture.png, 'base64')
      assert.equal(png.readUInt32BE(16), Math.round(capture.bounds.width * capture.deviceScale))
      assert.equal(png.readUInt32BE(20), Math.round(capture.bounds.height * capture.deviceScale))
      await writeFile(join(output, '920-zoom125.png'), png)
      console.log(JSON.stringify({ capture: { size: capture.size, scale: capture.scale, deviceScale: capture.deviceScale, bounds: capture.bounds } }))
    }
  }
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(920, 900); window.webContents.setZoomFactor(1.25) })
  // Remove the other active candidate so the paused Hero remains the focus.
  await app.evaluate(({ BrowserWindow }) => { globalThis.__heroQATasks[1].status = 'paused'; BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: globalThis.__heroQATasks }) })
  await win.locator('[data-hero-state] button[aria-label="暂停下载"]').click()
  await win.locator('[data-hero-state="paused"]').waitFor()
  const resting = await win.locator('[data-hero-state]').evaluate(hero => {
    const main = document.querySelector('#main-content').getBoundingClientRect()
    const nodes = [hero.querySelector('h1'), hero.querySelector('[data-hero-rest-progress]'), hero.querySelector('button[aria-label="继续下载"]')].map(e => e.getBoundingClientRect())
    return { outside: nodes.some(r => r.left < main.left - 1 || r.right > main.right + 1), overlaps: nodes.some((r, i) => nodes.slice(i + 1).some(s => Math.min(r.right, s.right) > Math.max(r.left, s.left) + 1 && Math.min(r.bottom, s.bottom) > Math.max(r.top, s.top) + 1)) }
  })
  assert.deepEqual(resting, { outside: false, overlaps: false })
  await win.locator('[data-hero-state] button[aria-label="继续下载"]').click()
  await win.locator('[data-hero-state="downloading"]').waitFor()
  const operations = await app.evaluate(() => globalThis.__heroQAOps)
  assert.deepEqual(operations, [{ op: 'pause', taskID: 902771 }, { op: 'resume', taskID: 902771 }])
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, errors, resting, operations }, null, 2))
  assert.deepEqual(errors, [])
  assert.deepEqual(results.filter(row => row.outside.length || row.overlapping), [], 'Hero controls must remain inside main and not overlap at actual Electron zoom')
} finally { await app.close() }
