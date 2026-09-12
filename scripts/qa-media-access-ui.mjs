import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app = await electron.launch(qaLaunchOptions('media-access-ui'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain }) => {
    globalThis.__accessQA = { kind: 'regionRestricted', probes: [], adds: 0 }
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', () => ({ kind: 'html' }))
    const originalRequest = ipcMain._invokeHandlers.get('engine:request')
    if (typeof originalRequest !== 'function') throw new Error('Missing production engine request handler')
    // Keep private durable-draft IPC on the real encrypted controller.
    ipcMain.removeHandler('system:read-clipboard')
    ipcMain.handle('system:read-clipboard', () => '')
    ipcMain.removeHandler('system:clipboard-snapshot')
    ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0, selfWritten: false }))
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_e, op, extra) => {
      if (['composerDraftLoad', 'composerDraftSave', 'composerDraftDiscard', 'composerDraftFlushResult'].includes(op)) return originalRequest(_e, op, extra)
      const q = globalThis.__accessQA
      if (op === 'probeMedia') { q.probes.push(extra.cookieBrowser ?? null); return { ok: false, errorKind: q.kind } }
      if (op === 'add' || op === 'startYtDlp') q.adds++
      return { ok: true, tasks: [] }
    })
  })
  // Activate clipboard offers only after synthetic handlers are installed.
  await completeOnboarding(win)
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const input = win.getByPlaceholder(/粘贴下载链接/)
  const url = 'https://example.test/fixture-media'
  await input.fill(url)
  const status = win.locator('#composer-probe-status')
  await status.filter({ hasText: '地区' }).waitFor({ timeout: 5000 })
  assert.equal(await win.getByRole('button', { name: '使用 Chrome 会话重试', exact: true }).count(), 0)
  await win.getByRole('button', { name: '选项', exact: true }).click()
  const filename = win.getByPlaceholder('留空自动识别文件名')
  await filename.fill('Keep my filename.mp4')
  const download = win.getByRole('button', { name: '开始下载', exact: true })
  if (await download.isEnabled()) await download.click()
  assert.equal((await app.evaluate(() => globalThis.__accessQA)).adds, 0)
  await app.evaluate(() => { globalThis.__accessQA.kind = 'entitlementRequired' })
  await win.getByRole('button', { name: '重试解析', exact: true }).click()
  await status.filter({ hasText: '权限' }).waitFor()
  await win.getByRole('button', { name: '使用 Chrome 会话重试', exact: true }).click()
  await status.filter({ hasText: '权限' }).waitFor()
  await win.waitForFunction(() => !document.querySelector('button[disabled]')?.textContent?.includes('会话'))
  assert.equal(await input.inputValue(), url)
  assert.equal(await filename.inputValue(), 'Keep my filename.mp4')
  const result = await app.evaluate(() => globalThis.__accessQA)
  assert.deepEqual(result.probes, [null, null, 'chrome'])
  assert.equal(result.adds, 0)
  if (process.env.NDM_QA_SCREENSHOT) await win.screenshot({ path: process.env.NDM_QA_SCREENSHOT })
  console.log(JSON.stringify({ passed: true, regionNoLoginAction: true, explicitEntitlementSession: true, noHTMLDownload: true, inputPreserved: true }))
} finally { await app.close() }
