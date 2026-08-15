import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('zoom', { seedHistory: true }))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForSelector('ul li', { timeout: 15_000 })
const baselineWidth = await win.evaluate(() => window.innerWidth)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.8))
await win.waitForFunction((width) => window.innerWidth < width, baselineWidth)

const state = await win.evaluate(() => {
  const sidebar = document.querySelector('body > #root aside')
  const nav = sidebar?.querySelector('nav')
  const settings = [...(sidebar?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === '设置')
  return {
    innerWidth: window.innerWidth,
    sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
    navClientHeight: nav?.clientHeight ?? 0,
    navScrollHeight: nav?.scrollHeight ?? 0,
    navOverflowY: nav ? getComputedStyle(nav).overflowY : '',
    settingsBottom: settings?.getBoundingClientRect().bottom ?? 0,
    viewportHeight: window.innerHeight,
    settingsVisible: Boolean(settings && settings.getBoundingClientRect().top >= 0 && settings.getBoundingClientRect().bottom <= window.innerHeight)
  }
})

const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
  const image = await BrowserWindow.getAllWindows()[0].capturePage()
  return image.toPNG().toString('base64')
})
writeFileSync('/tmp/ndm-zoom.png', Buffer.from(screenshot, 'base64'))
console.log(JSON.stringify({ state, issues }))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1))
await app.close()
