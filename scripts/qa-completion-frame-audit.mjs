import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions, completeOnboarding, isolateQAClipboard } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('completion-frames'))
const report = { scope: 'Isolated Electron renderer; synthetic completion event, not a real transfer', runs: [] }
try {
  await isolateQAClipboard(app)
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[data-sidebar-mode]', { timeout: 15000 })
  await completeOnboarding(win)
  await win.getByTestId('completion-confetti').waitFor({ state: 'attached' })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    window.__frames = { gaps: [], longTasks: [], fires: [], last: performance.now() }
    const loop = now => { const s = window.__frames; s.gaps.push({ at: now, ms: now - s.last }); s.last = now; requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
    new PerformanceObserver(list => window.__frames.longTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: false })
    const canvas = document.querySelector('[data-testid="completion-confetti"]')
    if (canvas) new MutationObserver(records => {
      if (records.some(r => r.attributeName === 'data-confetti-fires')) window.__frames.fires.push(performance.now())
    }).observe(canvas, { attributes: true })
  })
  for (let i = 0; i < 3; i++) {
    const task = { id: 990001 + i, title: 'Completion frame fixture', filename: `fixture-${i}.zip`, folderPath: '/tmp', url: 'https://example.invalid/fixture.zip', source: 'example.invalid', category: 'compressed', connections: 1, segments: [], fileSize: 1048576, completedBytes: 524288, bytesPerSecond: 65536, status: 'downloading' }
    const push = async t => app.evaluate(({ BrowserWindow }, task) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: [task] }), t)
    await push(task)
    await win.waitForTimeout(60)
    const start = await win.evaluate(() => performance.now())
    await push({ ...task, status: 'complete', completedBytes: task.fileSize, bytesPerSecond: 0 })
    if (i === 0 && process.env.NDM_FRAME_SCREENSHOT) {
      await win.waitForTimeout(120)
      await win.screenshot({ path: process.env.NDM_FRAME_SCREENSHOT })
    }
    await win.waitForTimeout(2800)
    const measurement = await win.evaluate(start => {
      const s = window.__frames, gaps = s.gaps.filter(e => e.at >= start && e.at <= start + 2500).map(e => e.ms).sort((a,b) => a-b)
      return { slowFrames: s.gaps.filter(e => e.at >= start && e.at <= start + 2500 && e.ms > 25).map(e => ({ afterMS: e.at - start, gapMS: e.ms })), maxFrameGapMS: Math.max(...gaps), p95FrameGapMS: gaps[Math.floor(gaps.length * .95)], framesOver50MS: gaps.filter(ms => ms > 50).length, longTasks: s.longTasks.filter(e => e.at >= start), fireDelayMS: s.fires.find(t => t >= start) - start, hasCanvas: Boolean(document.querySelector('[data-testid="completion-confetti"]')) }
    }, start)
    if (!measurement.hasCanvas || !Number.isFinite(measurement.fireDelayMS)) throw new Error('Completion animation was not triggered: ' + JSON.stringify(measurement))
    report.runs.push(measurement)
  }
  report.workers = win.workers().map(worker => worker.url().split(':')[0])
  if (!process.env.NDM_QA_APP_PATH && !report.workers.includes('blob')) throw new Error('Animation worker did not start')
  if (!process.env.NDM_QA_APP_PATH) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: [{ id: 990099, title: 'Unknown category fixture', filename: 'fixture.bin', folderPath: '/tmp', url: 'https://example.invalid/fixture.bin', source: 'example.invalid', category: 'unknown-fixture', connections: 1, segments: [], fileSize: 1024, completedBytes: 1024, status: 'complete' }] }))
    await win.waitForTimeout(80)
    await win.getByText('fixture.bin', { exact: true }).first().waitFor()
    report.unknownCategorySurvived = true
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(JSON.stringify(report, null, 2))
  if (process.env.NDM_FRAME_REPORT) writeFileSync(process.env.NDM_FRAME_REPORT, JSON.stringify(report, null, 2))
} finally {
  // These direct child Hosts belong to this fresh, empty QA instance only.
  const parent = app.process().pid
  const children = execFileSync('ps', ['-axo', 'pid,ppid,comm'], { encoding: 'utf8' }).split('\n')
  for (const line of children) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match && Number(match[2]) === parent && match[3].endsWith('/NDMHost')) {
      process.kill(Number(match[1]), 'SIGTERM')
    }
  }
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
