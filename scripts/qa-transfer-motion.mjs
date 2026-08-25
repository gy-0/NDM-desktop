import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('transfer-motion'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})

try {
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(
    async () => await window.ndm?.status().catch(() => 'down') === 'live',
    undefined,
    { timeout: 20_000 }
  )

  const task = {
    id: 9_001_800,
    title: 'NDM Slosh Integration QA',
    filename: 'NDM-Slosh-Integration-QA.dmg',
    folderPath: '/tmp',
    url: 'https://cdn.example.com/NDM-Slosh-Integration-QA.dmg',
    source: 'cdn.example.com',
    category: 'application',
    connections: 8,
    segments: Array.from({ length: 8 }, (_, index) => ({ id: index, fraction: 0.63 })),
    fileSize: 1_000_000_000,
    completedBytes: 630_000_000,
    bytesPerSecond: 24_000_000,
    status: 'downloading',
    phase: 'transferring'
  }

  const pushSnapshot = async () => {
    await app.evaluate(({ BrowserWindow }, nextTask) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', { op: 'snapshot', tasks: [nextTask] })
    }, task)
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await pushSnapshot()
    if (await win.getByText(task.filename, { exact: true }).count()) break
    await win.waitForTimeout(160)
  }
  await win.getByText(task.filename, { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 })

  const hero = win.locator('section').filter({ hasText: task.filename }).first()
  const canvas = hero.locator('canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 5_000 })
  await win.waitForTimeout(700)

  const surface = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      backingWidth: node.width,
      backingHeight: node.height,
      opacity: getComputedStyle(node).opacity,
      frames: node.__ndmFxFrames ?? 0
    }
  })
  const startedAt = performance.now()
  const frameHashes = []
  for (let sample = 0; sample < 4; sample += 1) {
    const frame = await canvas.screenshot()
    frameHashes.push(createHash('sha256').update(frame).digest('hex'))
    await win.waitForTimeout(160)
  }
  await win.waitForTimeout(1_000)
  const frameEnd = await canvas.evaluate((node) => node.__ndmFxFrames ?? 0)
  const elapsedSeconds = (performance.now() - startedAt) / 1_000
  const result = {
    surface,
    fps: Number(((frameEnd - surface.frames) / elapsedSeconds).toFixed(1)),
    distinctFrames: new Set(frameHashes).size,
    issues
  }

  writeFileSync('/tmp/ndm-transfer-motion.png', await win.screenshot())
  console.log(JSON.stringify(result))
  if (
    surface.backingWidth / surface.cssWidth < 1.9 ||
    surface.backingHeight / surface.cssHeight < 1.9 ||
    result.fps < 50 ||
    result.distinctFrames < 3 ||
    issues.length > 0
  ) process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
