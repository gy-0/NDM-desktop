import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

// Library cleanup sheet QA: synthetic dead-link tasks exercise the failed
// bucket end to end (retry-all, remove, clean-state) without touching any
// real download history — everything runs in an isolated support dir.
const APP = '/Users/gaoyuan/NDM-desktop'
const consoleMessages = []
const shot = async (app, name) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const img = await w.capturePage()
    const [cw, ch] = w.getContentSize()
    return img.resize({ width: cw, height: ch, quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(`/tmp/ndm-shot-cleanup-${name}.png`, Buffer.from(b64, 'base64'))
}

const app = await electron.launch(qaLaunchOptions('cleanup-library'))
const win = await app.firstWindow()
win.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
  }
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
const onboarding = win.getByRole('dialog', { name: '欢迎使用 NDM' })
if (await onboarding.isVisible().catch(() => false)) {
  await onboarding.getByRole('button', { name: '跳过' }).click()
}
await win.waitForFunction(
  () => document.body.innerText.includes('引擎') === false || document.body.innerText.includes('添加下载'),
  undefined,
  { timeout: 15_000 }
)

// Two instantly-refusing links become failed tasks on the isolated engine.
// First wait until the host is actually live, or the add op bounces.
await win.waitForFunction(
  async () => {
    try {
      return (await window.ndm.status()) === 'live'
    } catch {
      return false
    }
  },
  undefined,
  { timeout: 30_000 }
)
await win.evaluate(async () => {
  for (const url of ['http://127.0.0.1:9/ndm-cleanup-a.bin', 'http://127.0.0.1:9/ndm-cleanup-b.bin']) {
    await window.ndm.request('add', { url })
  }
})
await win.waitForFunction(
  () => document.querySelectorAll('ul li').length >= 2,
  undefined,
  { timeout: 20_000 }
)
// Give the engine a moment to flip both rows to error status.
await win.waitForFunction(
  () => document.body.innerText.includes('失败'),
  undefined,
  { timeout: 20_000 }
)

const failedCountBefore = await win.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('ul li')).length
  return rows
})

// Open the cleanup sheet from the sidebar entry.
await win.getByRole('button', { name: /整理任务库/ }).click()
await win.waitForSelector('[role="dialog"][aria-label="整理任务库"]', { timeout: 5000 })
await win.waitForTimeout(600)
const sheet = await win.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="整理任务库"]')
  const text = dialog?.textContent ?? ''
  return {
    visible: Boolean(dialog),
    failedBucket: text.includes('失败任务'),
    retryButton: text.includes('重试全部'),
    removeButton: text.includes('移出列表')
  }
})
console.log('cleanup sheet:', JSON.stringify(sheet))
await shot(app, '1-sheet')

// Retry-all resets the rows to waiting; the refused links must fail again
// before the failed bucket repopulates its remove action.
await win.getByRole('button', { name: '重试全部' }).click()
await win.waitForFunction(
  () => document.querySelector('[role="dialog"]')?.textContent?.includes('已重试') ?? false,
  undefined,
  { timeout: 20_000 }
)
console.log('retry-all:', 'result banner shown')

await win.waitForFunction(
  () => Boolean(document.querySelector('[role="dialog"]')?.textContent?.includes('移出列表')),
  undefined,
  { timeout: 30_000 }
)

await win.getByRole('button', { name: '移出列表' }).first().click()
await win.waitForFunction(
  () => document.querySelector('[role="dialog"]')?.textContent?.includes('已移出') ?? false,
  undefined,
  { timeout: 20_000 }
)
console.log('remove:', 'result banner shown')
await shot(app, '2-after-remove')

// Sheet must reflect the now-clean library.
await win.waitForFunction(
  () => document.querySelector('[role="dialog"]')?.textContent?.includes('任务库很干净') ?? false,
  undefined,
  { timeout: 10_000 }
)
console.log('clean state:', 'empty buckets render the calm empty card')
await shot(app, '3-clean')

const remaining = await win.evaluate(() => document.querySelectorAll('ul li').length)
console.log('rows before:', failedCountBefore, '→ after:', remaining)

await win.keyboard.press('Escape')
await win.waitForTimeout(400)
const closedViaEscape = await win.evaluate(
  () => !document.querySelector('[role="dialog"][aria-label="整理任务库"]')
)
console.log('escape closes sheet:', closedViaEscape)

console.log('console issues:', consoleMessages.length ? consoleMessages.join('\n') : 'none')
await app.close()
console.log('DONE')
