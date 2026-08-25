import { _electron as electron } from 'playwright'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const launchOptions = qaLaunchOptions('inspector-resize', { seedHistory: true })
const qaRoot = dirname(launchOptions.env.NDM_SUPPORT_DIR)
const issues = []
let app

async function selectFirstTask(win) {
  await win.waitForSelector('ul li', { timeout: 15_000 })
  await win.locator('ul li').first().click()
  await win.getByRole('separator', { name: '调整任务详情宽度' }).waitFor()
}

try {
  app = await electron.launch(launchOptions)
  const win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
  })
  win.on('pageerror', (error) => issues.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await selectFirstTask(win)

  const inspector = win.locator('#task-inspector')
  const separator = win.getByRole('separator', { name: '调整任务详情宽度' })
  const before = await inspector.evaluate((element) => element.getBoundingClientRect().width)
  const separatorBox = await separator.boundingBox()
  if (!separatorBox) throw new Error('Inspector resize handle has no layout box')

  await win.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 140)
  await win.mouse.down()
  await win.mouse.move(separatorBox.x - 52, separatorBox.y + 140, { steps: 5 })
  await win.mouse.up()
  const afterPointer = await inspector.evaluate((element) => element.getBoundingClientRect().width)
  if (afterPointer < before + 48) {
    throw new Error(`Inspector did not grow with pointer drag: ${before} -> ${afterPointer}`)
  }

  await separator.focus()
  await win.keyboard.press('ArrowRight')
  const afterKeyboard = await inspector.evaluate((element) => element.getBoundingClientRect().width)
  if (Math.abs(afterKeyboard - (afterPointer - 16)) > 1) {
    throw new Error(`Inspector keyboard resize is inconsistent: ${afterPointer} -> ${afterKeyboard}`)
  }

  const stored = await win.evaluate(() => Number(localStorage.getItem('ndm.inspector.width')))
  if (Math.abs(stored - afterKeyboard) > 1) {
    throw new Error(`Inspector width was not persisted: stored ${stored}, visible ${afterKeyboard}`)
  }

  await win.reload()
  await completeOnboarding(win)
  await selectFirstTask(win)
  const afterReload = await win.locator('#task-inspector').evaluate((element) => element.getBoundingClientRect().width)
  if (Math.abs(afterReload - stored) > 1) {
    throw new Error(`Inspector width was not restored: stored ${stored}, restored ${afterReload}`)
  }

  await win.waitForTimeout(450)
  writeFileSync('/tmp/ndm-inspector-resized.png', await win.screenshot())
  if (issues.length) throw new Error(`Renderer issues: ${issues.join(' | ')}`)
  console.log(JSON.stringify({ before, afterPointer, afterKeyboard, stored, afterReload, issues }))
} finally {
  await app?.close().catch(() => {})
  if (existsSync(qaRoot)) {
    const trashed = spawnSync('/usr/bin/trash', [qaRoot], { encoding: 'utf8' })
    if (trashed.status !== 0) throw new Error(`Failed to trash Inspector QA root: ${trashed.stderr || trashed.stdout}`)
  }
}
