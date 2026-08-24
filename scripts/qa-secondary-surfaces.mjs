import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('secondary-surfaces'))
const win = await app.firstWindow()
const consoleIssues = []

win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleIssues.push(`[${message.type()}] ${message.text()}`)
  }
})

try {
await win.waitForLoadState('domcontentloaded')
await completeOnboarding(win)
await win.waitForTimeout(200)

await win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })))
const shortcuts = win.getByRole('dialog', { name: '键盘快捷键' })
await shortcuts.waitFor({ state: 'visible', timeout: 5_000 })
await win.screenshot({ path: '/tmp/ndm-secondary-shortcuts.png' })
console.log('shortcuts:', await shortcuts.isVisible())
await win.keyboard.press('Escape')

await win.waitForFunction(
  async () => await window.ndm?.status().catch(() => 'down') === 'live',
  undefined,
  { timeout: 30_000 }
)

const filename = 'ndm-secondary-delete.bin'
await win.evaluate(async (target) => {
  await window.ndm?.request('add', { url: `http://127.0.0.1:9/${target}` })
}, filename)
await win.getByText(filename, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
await win.getByText(filename, { exact: true }).click()
await win.keyboard.press('Delete')
const deletion = win.getByRole('dialog', { name: /删除这/ })
await deletion.waitFor({ state: 'visible', timeout: 5_000 })
await win.screenshot({ path: '/tmp/ndm-secondary-delete.png' })
console.log('delete dialog:', await deletion.isVisible())
await win.keyboard.press('Escape')

await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', {
    op: 'downloadCompleted',
    task: {
      id: 900_001,
      title: '设计验证',
      filename: 'NDM-Design-QA.dmg',
      folderPath: '/Users/gaoyuan/Downloads',
      fullPath: '/Users/gaoyuan/Downloads/NDM-Design-QA.dmg'
    }
  })
})
const completion = win.getByTestId('completion-bar')
await completion.waitFor({ state: 'visible', timeout: 5_000 })
await win.waitForTimeout(300)
await win.screenshot({ path: '/tmp/ndm-secondary-completion.png' })
console.log('completion bar:', await completion.isVisible())

await win.evaluate(async (target) => {
  const reply = await window.ndm?.request('list')
  for (const task of reply?.tasks ?? []) {
    if (task.filename === target) {
      await window.ndm?.request('remove', { taskID: task.id, deleteFile: false })
    }
  }
}, filename)

console.log('console issues:', consoleIssues.length ? consoleIssues.join('\n') : 'none')
if (consoleIssues.length) throw new Error(consoleIssues.join('\n'))
console.log('DONE')
} finally {
  await app.close().catch(() => undefined)
}
