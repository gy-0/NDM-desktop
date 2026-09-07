import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('media-preview-ui'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await app.evaluate(({ ipcMain }) => {
    globalThis.__previewQA = { probes: [], adds: [] }
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', () => ({ kind: 'html' }))
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_event, op, extra) => {
      const state = globalThis.__previewQA
      if (op === 'probeMedia') {
        state.probes.push({ url: extra.url, browser: extra.cookieBrowser ?? null })
        if (extra.url.endsWith('/session') && !extra.cookieBrowser) return { ok: false, errorKind: 'browserSessionRequired' }
        const preview = !extra.url.endsWith('/ordinary')
        return { ok: true, title: preview ? 'Preview fixture' : 'Ordinary short fixture', duration: 30,
          ...(preview ? { availabilityNotice: 'previewOnly' } : {}),
          formats: [{ id: '22', label: '720p', containerHint: 'MP4', fileSize: 10000, videoCodec: 'h264', audioCodec: 'aac', height: 720 }], subtitles: [] }
      }
      if (op === 'addMedia') {
        state.adds.push(extra)
        return { ok: true, task: { id: 'preview-fixture', url: extra.url, filename: 'Preview fixture.mp4', status: 'paused', downloadedBytes: 0, totalBytes: 10000, createdAt: Date.now() } }
      }
      return { ok: true, tasks: [] }
    })
  })
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const input = win.getByPlaceholder(/粘贴下载链接/)
  const notice = win.getByText('当前仅提供预览', { exact: true })
  const download = win.getByRole('button', { name: '开始下载', exact: true })
  await input.fill('https://example.test/preview')
  await notice.waitFor({ timeout: 5000 })
  assert.equal(await download.isEnabled(), true, 'Preview remains downloadable')
  if (process.env.NDM_QA_SCREENSHOT) await win.screenshot({ path: process.env.NDM_QA_SCREENSHOT })
  await input.fill('https://example.test/ordinary')
  await win.getByText('Ordinary short fixture', { exact: true }).waitFor()
  assert.equal(await notice.count(), 0, 'Previous preview notice must not label an ordinary short video')
  await input.fill('https://example.test/session')
  await win.getByRole('button', { name: '使用 Chrome 会话重试', exact: true }).click()
  await notice.waitFor()
  await download.click()
  await input.waitFor({ state: 'hidden' })
  const result = await app.evaluate(() => globalThis.__previewQA)
  assert.equal(result.adds.length, 1)
  assert.equal(result.adds[0].cookieBrowser, 'chrome')
  assert.equal(result.adds[0].formatID, '22')
  assert.deepEqual(result.probes.map(p => p.browser), [null, null, null, 'chrome'])
  console.log(JSON.stringify({ passed: true, previewVisible: true, ordinaryShortUnlabelled: true, sessionPreviewVisible: true, previewDownloadAvailable: true, scope: 'real isolated Electron with mocked IPC; no actual site/account verification' }))
} finally { await app.close() }
