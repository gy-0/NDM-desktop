import { _electron as electron } from 'playwright'
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
await win.waitForTimeout(5000)

const result = await win.evaluate(() => ({
  title: document.title,
  canvases: document.querySelectorAll('canvas').length,
  webgpu: Boolean(navigator.gpu),
  visibleTiles: Array.from(document.querySelectorAll('section')).filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }).length
}))

const png = await app.evaluate(async ({ BrowserWindow }) => {
  const image = await BrowserWindow.getAllWindows()[0].capturePage()
  return image.toPNG().toString('base64')
})
writeFileSync('/tmp/ndm-product-motion.png', Buffer.from(png, 'base64'))

console.log(JSON.stringify({ ...result, issues }))
await app.close()

if (!result.webgpu || result.canvases !== 3 || result.visibleTiles !== 3 || issues.length > 0) process.exitCode = 1
