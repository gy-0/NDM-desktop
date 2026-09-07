import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('speed-history'))
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm?.status().catch(() => 'down') === 'live')
  const task = {
    id: 9_002_220, filename: 'Speed-history-QA.bin', title: 'Speed history', folderPath: '/tmp',
    url: 'https://example.test/history.bin', source: 'example.test', category: 'misc', connections: 2,
    fileSize: 1_000_000, completedBytes: 100_000, bytesPerSecond: 100_000,
    status: 'downloading', phase: 'transferring', segments: []
  }
  const push = () => app.evaluate(({ BrowserWindow }, task) => {
    BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: [task] })
  }, task)
  for (let i = 0; i < 12; i++) {
    await push()
    if (await win.getByText(task.filename, { exact: true }).count()) break
    await win.waitForTimeout(120)
  }
  await win.getByText(task.filename, { exact: true }).first().click()
  const line = win.locator('[data-speed-path]')
  await line.waitFor({ state: 'attached' })
  await push()
  // Identical snapshots are genuine telemetry even if the table skips re-rendering.
  await win.waitForTimeout(650)
  await push()
  await win.waitForTimeout(400)
  const constant = await line.evaluate(path => ({ d: path.getAttribute('d'), width: path.getBBox().width }))
  assert.ok(constant.width > 3, `Constant-speed observations were discarded: ${JSON.stringify(constant)}`)
  await win.evaluate(() => {
    window.__speedFrames = []
    const start = performance.now()
    const sample = now => {
      window.__speedFrames.push(document.querySelector('[data-speed-path]')?.getAttribute('d'))
      if (now - start < 650) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  task.bytesPerSecond = 50_000
  await win.waitForTimeout(200)
  await push()
  await win.waitForTimeout(700)
  const frames = await win.evaluate(() => window.__speedFrames)
  assert.ok(new Set(frames).size >= 5, 'New samples must move through intermediate geometry')
  assert.ok(frames.every(d => typeof d === 'string' && !/NaN|Infinity/.test(d)), 'Invalid SVG geometry')
  const geometry = await line.evaluate(path => {
    const fill = path.previousElementSibling
    const l = path.getBBox(), f = fill?.getBBox()
    return { lineStart: l.x, lineEnd: l.x + l.width, fillStart: f?.x, fillEnd: f ? f.x + f.width : null }
  })
  assert.ok(geometry.lineStart > 240, 'Brief history must occupy only the recent edge of a 30-second window')
  assert.ok(Math.abs(geometry.fillStart - geometry.lineStart) < 0.2, 'Fill invented earlier history')
  assert.ok(Math.abs(geometry.fillEnd - geometry.lineEnd) < 0.2, 'Fill extended past real samples')
  await win.emulateMedia({ reducedMotion: 'reduce' })
  task.bytesPerSecond = 25_000
  await push()
  await win.waitForTimeout(100)
  const reduced = await line.getAttribute('d')
  await win.waitForTimeout(350)
  assert.equal(await line.getAttribute('d'), reduced, 'Reduced-motion geometry kept animating')
  await win.screenshot({ path: '/tmp/ndm-speed-history-final.png' })
  task.status = 'paused'
  await push()
  await win.waitForTimeout(200)
  assert.equal(await line.count(), 0, 'Paused task retained a live speed chart')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, constantWidth: constant.width, distinctFrames: new Set(frames).size, geometry, reducedMotion: true, pause: true }))
} finally {
  await app.close()
}
