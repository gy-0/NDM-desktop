import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app = await electron.launch(qaLaunchOptions('composer-keyboard'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  const trigger = win.getByRole('button', { name: '添加下载', exact: true }).first()
  await trigger.focus()
  await win.keyboard.press('Enter')
  const input = win.getByPlaceholder(/粘贴下载链接/)
  await input.waitFor()
  const report = { escaped: [], dialogCount: await win.getByRole('dialog', { name: '添加下载', exact: true }).count() }
  await win.getByRole('button', { name: '选项', exact: true }).click()
  assert.equal(await win.getByRole('button', { name: '选项', exact: true }).getAttribute('aria-expanded'), 'true')
  assert.equal(await win.getByRole('textbox', { name: '下载链接', exact: true }).count(), 1)
  assert.equal(await win.getByRole('textbox', { name: '重命名', exact: true }).count(), 1)
  for (let i = 0; i < 50; i++) {
    await win.keyboard.press(i < 25 ? 'Tab' : 'Shift+Tab')
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const active = await win.evaluate(() => ({ inside: Boolean(document.activeElement?.closest('.ndm-composer')), text: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.slice(0, 60) }))
    if (!active.inside) report.escaped.push(active.text)
  }
  await win.getByRole('button', { name: '选项', exact: true }).focus()
  await win.keyboard.press('Escape')
  report.closed = !await input.isVisible()
  report.focusReturned = await trigger.evaluate(e => e === document.activeElement)
  console.log(JSON.stringify(report))
  assert.deepEqual(report.escaped, [], 'Tab must stay within the active Composer')
  assert.equal(report.dialogCount, 1, 'Composer must have an accessible dialog name')
  assert.equal(report.closed, true, 'Escape must work from non-input controls')
  assert.equal(report.focusReturned, true, 'Closing must restore the opening control')
} finally { await app.close() }
