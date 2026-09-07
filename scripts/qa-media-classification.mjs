import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('media-classification'))
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await app.evaluate(({ ipcMain }) => {
    globalThis.__classificationQA = { mode: 'unknown', operations: [] }
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', async () => {
      if (globalThis.__classificationQA.mode === 'reject') throw new Error('Fixture classification unavailable')
      return { kind: globalThis.__classificationQA.mode }
    })
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', async (_event, op) => {
      globalThis.__classificationQA.operations.push(op)
      if (op === 'probeMedia') return { ok: true, formats: [] }
      return { ok: true, tasks: [] }
    })
  })
  for (const mode of ['unknown', 'reject']) {
    await app.evaluate(({ BrowserWindow }, mode) => {
      globalThis.__classificationQA.mode = mode
      globalThis.__classificationQA.operations = []
      BrowserWindow.getAllWindows()[0].webContents.send('engine:event', {
        op: 'openMediaComposer', url: 'https://www.bilibili.com/video/BV1fixture?p=3'
      })
    }, mode)
    await win.getByPlaceholder(/粘贴下载链接/).waitFor()
    await win.locator('#composer-probe-status').filter({ hasText: /没能从|没能分析/ }).waitFor()
    await win.getByRole('button', { name: /^开始下载/ }).click()
    await win.getByText(/还没解析出视频轨，无法开始下载/).waitFor()
    const operations = await app.evaluate(() => globalThis.__classificationQA.operations)
    assert.ok(operations.includes('probeMedia'), `${mode}: media probe missing`)
    assert.ok(!operations.includes('add'), `${mode}: ordinary task was created`)
    await win.getByRole('button', { name: '取消', exact: true }).click()
    await win.getByPlaceholder(/粘贴下载链接/).waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, unknownAndRejectedClassification: true, noOrdinaryDownloads: true, errors }))
} finally { await app.close() }
