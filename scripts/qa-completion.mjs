import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('completion'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
const task = {
  id: 9_001_001,
  title: 'NDM Completion QA',
  filename: 'NDM-Completion-QA.dmg',
  folderPath: '/tmp',
  fileSize: 1024,
  completedBytes: 512,
  status: 'downloading'
}

await win.evaluate((snapshot) => window.ndm?.notifySnapshot?.([snapshot], true), task)
await win.waitForTimeout(80)
await win.evaluate(
  (snapshot) => window.ndm?.notifySnapshot?.([{ ...snapshot, status: 'complete', completedBytes: 1024 }], true),
  task
)

const bar = win.getByTestId('completion-bar').filter({ hasText: 'NDM-Completion-QA.dmg' })
await bar.waitFor({ state: 'visible', timeout: 5_000 })
await win.waitForTimeout(250)
const state = {
  filename: await bar.getByText('NDM-Completion-QA.dmg').isVisible(),
  revealAction: await bar.getByRole('button', { name: '在访达中显示' }).isVisible(),
  openAction: await bar.getByRole('button', { name: '打开文件' }).isVisible(),
  appFocused: await win.evaluate(() => document.hasFocus())
}

writeFileSync('/tmp/ndm-completion.png', await win.screenshot())
await bar.getByRole('button', { name: '关闭完成提示' }).click()
await bar.waitFor({ state: 'detached', timeout: 2_000 })
console.log(JSON.stringify({ state, dismissed: true, issues }))
await app.close()
