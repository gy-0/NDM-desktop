import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('media-session-browser'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain }) => {
    globalThis.__sessionQA = { browsers: [], adds: [], ordinaryAdds: 0 }
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
    ipcMain.handle('engine:request', async (_event, op, extra) => {
      if (['composerDraftLoad', 'composerDraftSave', 'composerDraftDiscard', 'composerDraftFlushResult'].includes(op)) return originalRequest(_event, op, extra)
      const state = globalThis.__sessionQA
      if (op === 'probeMedia') {
        state.browsers.push(extra.cookieBrowser ?? null)
        if (state.browsers.length === 1) return { ok: false, errorKind: 'browserSessionRequired' }
        await new Promise(resolve => setTimeout(resolve, 400))
        if (state.browsers.length === 2) return { ok: false, errorKind: 'browserDataUnavailable' }
        return { ok: true, title: 'Session fixture', formats: [{ id: '22', label: '720p', containerHint: 'MP4', fileSize: 10000, videoCodec: 'h264', audioCodec: 'aac', height: 720 }], subtitles: [] }
      }
      if (op === 'add') state.ordinaryAdds++
      if (op === 'addMedia') {
        state.adds.push(extra)
        return { ok: true, task: { id: 'session-fixture', url: extra.url, filename: 'Session fixture.mp4', status: 'paused', downloadedBytes: 0, totalBytes: 10000, createdAt: Date.now() } }
      }
      return { ok: true, tasks: [] }
    })
  })
  // Activate clipboard offers only after synthetic handlers are installed.
  await completeOnboarding(win)
  const initialPreference = await win.evaluate(() => localStorage.getItem('ndm.session.browser'))
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const url = 'https://example.test/session-fixture'
  await win.getByPlaceholder(/粘贴下载链接/).fill(url)
  const browser = win.getByRole('combobox', { name: '会话浏览器', exact: true })
  await browser.selectOption('firefox')
  if (process.env.NDM_QA_SCREENSHOT) await win.screenshot({ path: process.env.NDM_QA_SCREENSHOT })
  assert.deepEqual(await app.evaluate(() => globalThis.__sessionQA.browsers), [null], 'Selecting a browser must not read its session')
  await win.getByRole('button', { name: '使用 Firefox 会话重试', exact: true }).click()
  assert.equal(await browser.isDisabled(), true, 'Pending request must retain its browser identity')
  await win.locator('#composer-probe-status').filter({ hasText: '无法读取 Firefox 的登录信息' }).waitFor()
  await win.getByRole('button', { name: '重试解析', exact: true }).click()
  await win.getByText('Session fixture', { exact: true }).waitFor()
  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await win.getByPlaceholder(/粘贴下载链接/).waitFor({ state: 'hidden' })
  const result = await app.evaluate(() => globalThis.__sessionQA)
  assert.deepEqual(result.browsers, [null, 'firefox', 'firefox'])
  assert.equal(result.adds.length, 1)
  assert.equal(result.adds[0].cookieBrowser, 'firefox')
  assert.equal(result.adds[0].url, url)
  assert.equal(result.ordinaryAdds, 0)
  // A failed explicitly authorized source may be changed locally, without
  // reading the new source until the user invokes retry.
  await app.evaluate(() => { globalThis.__sessionQA = { browsers: [], adds: [], ordinaryAdds: 0 } })
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const secondURL = 'https://example.test/session-switch-fixture'
  await win.getByPlaceholder(/粘贴下载链接/).fill(secondURL)
  await browser.selectOption('firefox')
  await win.getByRole('button', { name: '使用 Firefox 会话重试', exact: true }).click()
  await win.locator('#composer-probe-status').filter({ hasText: '无法读取 Firefox 的登录信息' }).waitFor()
  await browser.selectOption('safari')
  await win.waitForTimeout(450)
  assert.deepEqual(await app.evaluate(() => globalThis.__sessionQA.browsers), [null, 'firefox'], 'Switching after a failure must not read Safari automatically')
  assert.equal(await win.evaluate(() => localStorage.getItem('ndm.session.browser')), initialPreference, 'Local browser selection changed the global preference')
  await win.getByRole('button', { name: '重试解析', exact: true }).click()
  assert.equal(await browser.isDisabled(), true)
  await win.getByText('Session fixture', { exact: true }).waitFor()
  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await win.getByPlaceholder(/粘贴下载链接/).waitFor({ state: 'hidden' })
  const switched = await app.evaluate(() => globalThis.__sessionQA)
  assert.deepEqual(switched.browsers, [null, 'firefox', 'safari'])
  assert.equal(switched.adds.length, 1)
  assert.equal(switched.adds[0].cookieBrowser, 'safari')
  assert.equal(switched.adds[0].url, secondURL)
  assert.equal(switched.ordinaryAdds, 0)
  assert.equal(await win.evaluate(() => localStorage.getItem('ndm.session.browser')), initialPreference)
  console.log(JSON.stringify({ passed: true, selectionDoesNotProbe: true, pendingSelectionLocked: true, browsers: result.browsers, downloadBrowser: result.adds[0].cookieBrowser, switchedBrowsers: switched.browsers, switchedDownloadBrowser: switched.adds[0].cookieBrowser, globalPreferenceUnchanged: true, scope: 'isolated Electron with mocked IPC; no real browser cookies read' }))
} finally {
  await app.close()
}
