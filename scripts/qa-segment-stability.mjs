import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('segment-stability'))
try {
  const win = await app.firstWindow()
  win.on('pageerror', error => console.error('renderer:', error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.evaluate(() => {
    localStorage.setItem('ndm-progress-style', 'segmented')
    window.dispatchEvent(new CustomEvent('ndm-progress-style-change', { detail: 'segmented' }))
  })
  await win.waitForFunction(async () => await window.ndm?.status().catch(() => 'down') === 'live')
  const task = {
    id: 9_002_110, filename: 'Segment-stability-QA.bin', title: 'Segment stability',
    folderPath: '/tmp', url: 'https://example.test/segment.bin', source: 'example.test',
    category: 'misc', connections: 2, fileSize: 1_000_000, completedBytes: 500_000,
    bytesPerSecond: 100_000, status: 'downloading', phase: 'transferring',
    segments: [{ id: 0, fraction: 1 }, { id: 1, fraction: 0 }]
  }
  const push = async () => app.evaluate(({ BrowserWindow }, task) => {
    BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: [task] })
  }, task)
  for (let i = 0; i < 12; i++) {
    await push()
    if (await win.locator('[data-hero-segment-summary]').count()) break
    await win.waitForTimeout(120)
  }
  const fills = win.locator('[data-hero-progress] [data-progress-style="segmented"] [data-progress-fill]')
  if (!await fills.count()) console.log(await win.locator('body').innerText())
  await fills.first().waitFor({ state: 'visible' })
  await win.waitForTimeout(700)
  const read = () => fills.evaluateAll(nodes => nodes.map(node => Number(node.style.transform.match(/scaleX\(([^)]+)\)/)?.[1])))
  assert.deepEqual(await read(), [1, 0])
  await win.evaluate(() => {
    window.__segmentSamples = []
    const start = performance.now()
    const sample = now => {
      window.__segmentSamples.push([...document.querySelectorAll('[data-hero-progress] [data-progress-style="segmented"] [data-progress-fill]')]
        .map(node => Number(node.style.transform.match(/scaleX\(([^)]+)\)/)?.[1])))
      if (now - start < 800) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  task.completedBytes = 600_000
  task.segments[1].fraction = 0.2
  await push()
  await win.waitForTimeout(900)
  const samples = await win.evaluate(() => window.__segmentSamples)
  assert.ok(samples.length > 8, 'Must observe actual compositor frames')
  assert.ok(samples.every(([a]) => a >= 0.999), `Completed segment receded: ${JSON.stringify(samples)}`)
  assert.ok(samples.every(([a, b]) => (a + b) / 2 <= 0.60001), 'Painted progress exceeds received bytes')
  assert.ok(samples.some(([, b]) => b > 0.01 && b < 0.19), 'New progress must animate through intermediate values')
  // A real engine correction must remain visible, despite retained history.
  task.completedBytes = 400_000
  task.segments = [{ id: 0, fraction: 0.7 }, { id: 1, fraction: 0.1 }]
  await push()
  await win.waitForTimeout(120)
  const corrected = await read()
  assert.ok(corrected[0] <= 0.70001 && corrected[1] <= 0.10001)
  // Pause with a fresh target must settle without requiring a continuing loop.
  task.status = 'paused'
  task.completedBytes = 500_000
  task.segments = [{ id: 0, fraction: 0.8 }, { id: 1, fraction: 0.2 }]
  await push()
  await win.waitForTimeout(200)
  const paused = await read()
  assert.ok(Math.abs(paused[0] - 0.8) < 0.001 && Math.abs(paused[1] - 0.2) < 0.001)
  task.id += 1
  task.status = 'downloading'
  task.completedBytes = 150_000
  task.segments = [{ id: 0, fraction: 0.2 }, { id: 1, fraction: 0.1 }]
  await push()
  await win.waitForTimeout(600)
  assert.deepEqual(await read(), [0.2, 0.1], 'A different task must not inherit fills')
  await win.emulateMedia({ reducedMotion: 'reduce' })
  task.completedBytes = 300_000
  task.segments = [{ id: 0, fraction: 0.4 }, { id: 1, fraction: 0.2 }]
  await push()
  await win.waitForTimeout(200)
  assert.deepEqual(await read(), [0.4, 0.2], 'Reduced motion must show authoritative fills')
  console.log(JSON.stringify({ passed: true, frameSamples: samples.length, minCompletedFill: Math.min(...samples.map(s => s[0])), corrected, paused, taskSwitch: true, reducedMotion: true }))
} finally {
  await app.close()
}
