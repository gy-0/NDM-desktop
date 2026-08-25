import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('product-motion'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})

await win.waitForLoadState('domcontentloaded')
const url = new URL(win.url())
url.searchParams.set('fx', 'product')
await win.goto(url.toString())
await win.waitForSelector('canvas')
await win.waitForTimeout(1000)

const sloshCanvas = win.locator('section canvas').first()
const frameStart = await sloshCanvas.evaluate((canvas) => canvas.__ndmFxFrames ?? 0)
const startedAt = performance.now()
const frameHashes = []
for (let sample = 0; sample < 4; sample += 1) {
  const frame = await sloshCanvas.screenshot()
  frameHashes.push(createHash('sha256').update(frame).digest('hex'))
  await win.waitForTimeout(160)
}
await win.waitForTimeout(1360)
const frameEnd = await sloshCanvas.evaluate((canvas) => canvas.__ndmFxFrames ?? 0)
const elapsedSeconds = (performance.now() - startedAt) / 1000
const measuredFps = (frameEnd - frameStart) / elapsedSeconds

const pageResult = await win.evaluate(() => ({
  title: document.title,
  canvases: document.querySelectorAll('canvas').length,
  webgpu: Boolean(navigator.gpu),
  visibleTiles: Array.from(document.querySelectorAll('section')).filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }).length
}))
const result = {
  ...pageResult,
  sloshFrames: frameEnd - frameStart,
  sloshFps: Number(measuredFps.toFixed(1)),
  distinctSloshFrames: new Set(frameHashes).size
}

const png = await app.evaluate(async ({ BrowserWindow }) => {
  const image = await BrowserWindow.getAllWindows()[0].capturePage()
  return image.toPNG().toString('base64')
})
writeFileSync('/tmp/ndm-product-motion.png', Buffer.from(png, 'base64'))

console.log(JSON.stringify({ ...result, issues }))
await app.close()

if (
  !result.webgpu ||
  result.canvases !== 2 ||
  result.visibleTiles !== 2 ||
  result.sloshFps < 45 ||
  result.distinctSloshFrames < 3 ||
  issues.length > 0
) process.exitCode = 1
