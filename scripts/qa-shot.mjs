import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const APP = '/Users/gaoyuan/NDM-desktop'
const consoleMessages = []

const app = await electron.launch(qaLaunchOptions('shot', { seedHistory: true }))
const win = await app.firstWindow()
win.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
  }
})

await win.waitForLoadState('domcontentloaded')
// wait for engine snapshot to land (rows or empty state)
await win.waitForSelector('ul li, .font-serif', { timeout: 15000 })
await win.waitForTimeout(2500)
await completeOnboarding(win)
await win.waitForTimeout(400)

async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const img = await w.capturePage()
    const [cw, ch] = w.getContentSize()
    return img.resize({ width: cw, height: ch, quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(`/tmp/ndm-shot-${name}.png`, Buffer.from(b64, 'base64'))
  console.log(`shot: ${name}`)
}

// --- checks ---
const metrics = await win.evaluate(async () => {
  await document.fonts.ready
  return {
    serifLoaded: document.fonts.check('16px "Instrument Serif"'),
    sansLoaded: document.fonts.check('16px "Instrument Sans"'),
    monoLoaded: document.fonts.check('12px "IBM Plex Mono"'),
    rows: document.querySelectorAll('ul li').length,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    engineText: document.body.innerText.includes('连接中断')
      ? 'down'
      : document.body.innerText.includes('正在连接')
      ? 'connecting'
      : 'live'
  }
})
console.log('metrics:', JSON.stringify(metrics))

await shot('1-main')

// composer via ⌘N
await win.keyboard.press('Meta+n')
await win.waitForTimeout(700)
const composerOpen = await win.evaluate(() => document.body.innerText.includes('添加下载任务'))
console.log('composer open:', composerOpen)
await shot('2-composer')
await win.keyboard.press('Escape')
await win.waitForTimeout(400)

// settings via ⌘,
await win.keyboard.press('Meta+,')
await win.waitForTimeout(800)
const settingsInfo = await win.evaluate(() => {
  const text = document.body.innerText
  return {
    open: text.includes('设置'),
    extensionSection: text.includes('NDM Relay'),
    extensionPathShown: /\/.*extension\/NDMRelay/.test(text),
    bridgePort: (text.match(/127\.0\.0\.1:(\d+)/) ?? [])[1] ?? null
  }
})
console.log('settings:', JSON.stringify(settingsInfo))
await shot('3-settings')
await win.keyboard.press('Escape')
await win.waitForTimeout(400)

// context menu on first row
const firstRow = win.locator('ul li').first()
if (await firstRow.count()) {
  await firstRow.click({ button: 'right' })
  await win.waitForTimeout(400)
  const menuOpen = await win.evaluate(() => document.body.innerText.includes('复制下载链接'))
  console.log('context menu open:', menuOpen)
  await shot('4-contextmenu')
  await win.keyboard.press('Escape')
}

console.log('console issues:', consoleMessages.length ? consoleMessages.join('\n') : 'none')
await app.close()
console.log('DONE')
