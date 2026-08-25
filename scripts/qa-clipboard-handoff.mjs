import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('clipboard-handoff'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})

try {
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  const url = `https://example.com/ndm-clipboard-${process.pid}.dmg`
  await win.evaluate(async (value) => {
    await window.ndm?.writeClipboard(value)
    window.dispatchEvent(new Event('focus'))
  }, url)

  const toastAction = win.getByRole('button', { name: '立即下载' })
  await toastAction.waitFor({ state: 'visible', timeout: 5_000 })
  await toastAction.click()
  const composerField = win.getByPlaceholder(/粘贴下载链接/)
  await composerField.waitFor({ state: 'visible', timeout: 5_000 })
  await win.waitForTimeout(500)

  const result = {
    composerVisible: await composerField.isVisible(),
    toastCount: await win.getByRole('button', { name: '立即下载' }).count(),
    fieldValue: await composerField.inputValue(),
    issues
  }
  console.log(JSON.stringify(result))
  if (!result.composerVisible || result.toastCount !== 0 || result.fieldValue !== url || issues.length > 0) process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
