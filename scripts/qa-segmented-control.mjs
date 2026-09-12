import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('segmented-control'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  if (process.env.NDM_QA_COMPACT) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  await app.evaluate(({ ipcMain }) => {
    globalThis.__previewQA = { probes: [], adds: [] }
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
    ipcMain.handle('engine:request', (_event, op, extra) => {
      if (['composerDraftLoad', 'composerDraftSave', 'composerDraftDiscard', 'composerDraftFlushResult'].includes(op)) return originalRequest(_event, op, extra)
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
  // Activate clipboard offers only after synthetic handlers are installed.
  await completeOnboarding(win)
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const input = win.getByPlaceholder(/粘贴下载链接/)
  const notice = win.getByText('当前仅提供预览', { exact: true })
  const download = win.getByRole('button', { name: '开始下载', exact: true })
  await input.fill('https://example.test/preview')
  await notice.waitFor({ timeout: 5000 })
  assert.equal(await download.isEnabled(), true, 'Preview remains downloadable')
  await win.evaluate(() => {
    window.__segmentFrames = [];
    window.__segmentSampling = true;
    function sample() {
      for (const indicator of document.querySelectorAll('.ndm-segmented-selection')) {
        const group = indicator.closest('.ndm-segmented');
        const button = group.querySelector('button[aria-pressed="true"]');
        if (!button) continue;
        const a = indicator.getBoundingClientRect(), b = button.getBoundingClientRect();
        window.__segmentFrames.push({ dy: Math.abs(a.top - b.top), dx: Math.abs(a.left - b.left) });
      }
      if (window.__segmentSampling) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await win.getByRole('button', { name: '选项', exact: true }).click();
  await download.scrollIntoViewIfNeeded();
  await win.waitForTimeout(400);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650));
  await win.waitForTimeout(400);
  const frames = await win.evaluate(() => { window.__segmentSampling = false; return window.__segmentFrames; });
  assert.ok(frames.length > 3);
  const maxDy = Math.max(...frames.map(frame => frame.dy));
  console.log(JSON.stringify({ samples: frames.length, maxVerticalDisplacement: maxDy }));
  assert.ok(maxDy <= 1, 'Selection must not detach vertically from its button during parent scrolling/layout: ' + maxDy);

  const group = win.locator('.ndm-segmented').filter({ has: win.getByRole('button', { name: 'MP4', exact: true }) }).first();
  await group.evaluate(track => {
    window.__slideXs = [];
    const start = performance.now();
    function sample() {
      window.__slideXs.push(track.querySelector('.ndm-segmented-selection').getBoundingClientRect().left);
      if (performance.now() - start < 400) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await group.locator('button[aria-pressed="false"]').click();
  await win.waitForTimeout(420);
  const horizontalPositions = await win.evaluate(() => window.__slideXs);
  assert.ok(new Set(horizontalPositions.map(value => Math.round(value * 10))).size >= 3, 'Normal motion must preserve intermediate horizontal positions');
  const aligned = await group.evaluate(track => {
    const a = track.querySelector('.ndm-segmented-selection').getBoundingClientRect();
    const b = track.querySelector('button[aria-pressed="true"]').getBoundingClientRect();
    return Math.abs(a.left - b.left) <= 1 && Math.abs(a.width - b.width) <= 1;
  });
  assert.equal(aligned, true, 'Selection change must finish aligned');
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await group.locator('button[aria-pressed="false"]').click();
  const transition = await group.locator('.ndm-segmented-selection').evaluate(el => getComputedStyle(el).transitionDuration);
  assert.ok(transition.split(',').every(value => parseFloat(value) <= 0.001), 'Reduced motion must disable the slide (global CSS may use a near-zero duration): ' + transition);
  console.log(JSON.stringify({ passed: true, maxVerticalDisplacement: maxDy, selectionAligned: true, reducedMotion: true }));
  if (process.env.NDM_QA_SCREENSHOT) await win.screenshot({ path: process.env.NDM_QA_SCREENSHOT })
} finally { await app.close() }
