import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app = await electron.launch(qaLaunchOptions('relay-path-copy'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  const path = '/Applications/NDM.app/Contents/Resources/extension/NDMRelay'
  await app.evaluate(({ ipcMain }, path) => {
    globalThis.__copyPath = { values: [], fail: true }
    ipcMain.removeHandler('system:extension-path')
    ipcMain.handle('system:extension-path', () => path)
    ipcMain.removeHandler('system:write-clipboard')
    ipcMain.handle('system:write-clipboard', (_event, text) => {
      globalThis.__copyPath.values.push(text)
      if (globalThis.__copyPath.fail) throw Error('fixture clipboard unavailable')
    })
  }, path)
  await win.getByRole('button', { name: '设置', exact: true }).first().click()
  await win.getByRole('button', { name: '浏览器扩展', exact: true }).click()
  await win.getByRole('button', { name: '复制', exact: true }).click()
  await win.getByRole('button', { name: '重试复制', exact: true }).waitFor()
  assert.equal(await win.getByText('复制失败，请重试', { exact: true }).isVisible(), true)
  await app.evaluate(() => { globalThis.__copyPath.fail = false })
  await win.getByRole('button', { name: '重试复制', exact: true }).click()
  await win.getByRole('button', { name: '已复制', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.__copyPath.values), [path, path])
  const row = win.locator('span[title]').filter({ hasText: path }).locator('..')
  const box = await row.boundingBox()
  assert.ok(box && box.width > 0)
  assert.equal(await row.evaluate(node => node.scrollWidth > node.clientWidth), false)
  if (process.env.NDM_QA_SCREENSHOT) await win.screenshot({ path: process.env.NDM_QA_SCREENSHOT })
  console.log(JSON.stringify({ passed: true, copyFailure: true, retry: true, exactPath: true, noOverflow: true }))
} finally { await app.close() }
