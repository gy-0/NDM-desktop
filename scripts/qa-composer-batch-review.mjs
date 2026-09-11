// Real Electron renderer with controlled engine replies. All files, profiles and
// ports are isolated; this checks creation intent without downloading anything.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const root = mkdtempSync('/tmp/ndm-composer-batch-review-')
const app = await electron.launch(qaLaunchOptions('composer-batch-review'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain, BrowserWindow }, root) => {
    BrowserWindow.getAllWindows()[0].setSize(1160, 820)
    const q = globalThis.composerReview = { root, added: [], duplicates: [], clipboard: '', pendingClipboard: null, holdClipboard: false, pendingProbe: null, pendingAdd: null, holdAdd: false, tasks: [] }
    const task = (id, url, filename, folderPath) => ({ id, url, filename, title: filename, folderPath, status: 'waiting', category: 'document', completedBytes: 0, fileSize: 8192, segments: [], connections: 4, activityAt: Date.now() })
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_event, op, args) => {
      if (op === 'getSettings') return { settings: { downloadDirectory: root, maxConnections: 16 } }
      if (op === 'checkStorage') return { ok: true, level: 'unknown' }
      if (op === 'list') return { ok: true, tasks: q.tasks }
      if (op === 'findDuplicate') {
        q.duplicates.push(args.urls)
        return { ok: true, duplicate: args.urls.some(url => url.endsWith('/existing.dmg')) ? { ...task(7, args.urls[0], '已有文件.dmg', root), status: 'complete' } : undefined }
      }
      if (op === 'probeMedia') return new Promise(resolve => { q.pendingProbe = resolve })
      if (op === 'add') {
        q.added.push(args)
        if (args.url.endsWith('/report.pdf') && q.added.filter(item => item.url === args.url).length === 1) return { ok: false, error: 'Fixture first attempt fails' }
        const finish = () => {
          const created = task(100 + q.added.length, args.url, new URL(args.url).pathname.split('/').at(-1), args.folderPath)
          q.tasks.push(created)
          return { ok: true, task: created }
        }
        if (q.holdAdd) return new Promise(resolve => { q.pendingAdd = () => { q.pendingAdd = null; resolve(finish()) } })
        return finish()
      }
      return { ok: true }
    })
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', (_event, url) => ({ kind: url.includes('youtube.com') ? 'html' : 'binary', contentType: 'application/octet-stream' }))
    ipcMain.removeHandler('system:read-clipboard')
    ipcMain.handle('system:read-clipboard', () => q.holdClipboard ? new Promise(resolve => { q.pendingClipboard = resolve }) : q.clipboard)
    ipcMain.removeHandler('dialog:select-folder')
    ipcMain.handle('dialog:select-folder', () => `${root}/Design assets`)
  }, root)
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  const dialog = win.getByRole('dialog', { name: '添加下载', exact: true })
  const input = win.getByRole('textbox', { name: '下载链接', exact: true })
  const open = async () => { await win.keyboard.press('Meta+n'); await dialog.waitFor(); await input.waitFor() }
  const paste = async text => input.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
  const added = () => app.evaluate(() => globalThis.composerReview.added)
  const waitPendingAdd = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await app.evaluate(() => Boolean(globalThis.composerReview.pendingAdd))) return
      await win.waitForTimeout(50)
    }
    throw new Error('Expected a pending add request')
  }
  const capture = async name => {
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await win.screenshot({ path: `${root}/${name}.png` })
  }
  await open()
  await paste('https://fixtures.invalid/Design%20Kit.zip\nhttps://fixtures.invalid/report.pdf\nhttps://fixtures.invalid/remove-me.jpg\nhttps://fixtures.invalid/report.pdf')
  await dialog.getByRole('region', { name: '待下载清单' }).waitFor()
  assert.equal((await added()).length, 0, 'Pasting a list must only prepare it')
  assert.equal(await dialog.locator('[data-batch-link]').count(), 3, 'Repeated URLs should appear once')
  await dialog.getByRole('button', { name: '移除第 3 项：remove-me.jpg', exact: true }).click()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  await dialog.getByRole('button', { name: '浏览', exact: true }).click()
  await dialog.getByText(`${root}/Design assets`, { exact: true }).waitFor()
  await capture('01-review')
  const draftWidth = await dialog.evaluate(element => element.getBoundingClientRect().width)
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
  await dialog.locator('[data-batch-notice]').filter({ hasText: '已添加 1 项，1 项未能添加。' }).waitFor()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 1)
  assert.equal(await dialog.evaluate(element => element.getBoundingClientRect().width), draftWidth, 'Partial success must not open the inspector and shrink the draft')
  assert.equal(await dialog.locator('[data-batch-link]').textContent(), 'report.pdf未能添加，可重试')
  await capture('02-partial-recovery')
  // Pasting the accepted item again during recovery must not create a duplicate.
  await paste('https://fixtures.invalid/Design%20Kit.zip')
  assert.equal(await dialog.locator('[data-batch-link]').count(), 1)
  await dialog.getByRole('button', { name: '重试 1 项', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const created = await added()
  assert.deepEqual(created.map(item => item.url), ['https://fixtures.invalid/Design%20Kit.zip', 'https://fixtures.invalid/report.pdf', 'https://fixtures.invalid/report.pdf'])
  assert.ok(created.every(item => item.folderPath === `${root}/Design assets`), 'Explicit destination must survive partial failure and retry')

  await open()
  await input.fill('https://fixtures.invalid/existing.dmg')
  await dialog.getByText('这项内容已经在下载列表中', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '查看已有', exact: true }).count(), 1)
  await capture('03-file-duplicate')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await open()
  await input.fill('https://www.youtube.com/watch?v=ndm-review')
  await dialog.getByRole('button', { name: '选项', exact: true }).click()
  const filename = dialog.getByRole('textbox', { name: '重命名', exact: true })
  await filename.fill('我的课程笔记.mp4')
  await win.waitForFunction(async () => (await window.ndm.request('ping'))?.ok === true)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await app.evaluate(() => Boolean(globalThis.composerReview.pendingProbe))) break
    await win.waitForTimeout(50)
  }
  assert.equal(await app.evaluate(() => Boolean(globalThis.composerReview.pendingProbe)), true)
  await app.evaluate(() => {
    globalThis.composerReview.pendingProbe({ ok: true, title: '课程演示', formats: [
      { id: '1080', label: '1080p', containerHint: 'MP4', height: 1080, approximateBytes: 100000, compactApproximateBytes: 90000 },
      { id: '720', label: '720p', containerHint: 'MP4', height: 720, approximateBytes: 50000, compactApproximateBytes: 45000 }
    ], subtitles: [] })
  })
  await dialog.getByText('课程演示', { exact: true }).waitFor()
  assert.equal(await filename.inputValue(), '我的课程笔记.mp4', 'Late media metadata must preserve the edited filename')
  await dialog.getByRole('button', { name: /720p/ }).click()
  assert.equal(await filename.inputValue(), '我的课程笔记.mp4', 'Changing quality must preserve the edited filename')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Compact Composer must not overflow horizontally')
  assert.equal(await dialog.getByRole('button', { name: '开始下载', exact: true }).evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }), true, 'Primary action must stay visible while media options scroll')
  await capture('04-media-filename')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await app.evaluate(() => { globalThis.composerReview.holdAdd = true })
  await open()
  await input.fill('https://fixtures.invalid/pending.zip')
  await dialog.getByRole('button', { name: '开始下载', exact: true }).click()
  await waitPendingAdd()
  await win.keyboard.press('Escape')
  assert.equal(await dialog.isVisible(), true, 'Escape must not discard a single download before its creation is acknowledged')
  await app.evaluate(() => globalThis.composerReview.pendingAdd())
  await dialog.waitFor({ state: 'hidden' })

  const inspector = win.locator('#task-inspector')
  await inspector.waitFor({ state: 'visible' })
  assert.equal(await inspector.getAttribute('data-overlay'), 'true')
  await open()
  assert.equal(await inspector.evaluate(element => getComputedStyle(element).visibility), 'hidden', 'Overlay details must not obscure or overlap the Composer background')
  await capture('05-inspector-hidden-during-compose')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await inspector.waitFor({ state: 'visible' })
  assert.equal(await inspector.getByRole('heading', { name: 'pending.zip', exact: true }).count(), 1, 'Closing Composer must restore the same selected task details')

  await open()
  await paste('https://fixtures.invalid/stop-one.zip\nhttps://fixtures.invalid/stop-two.pdf\nhttps://fixtures.invalid/stop-three.jpg')
  await dialog.getByRole('button', { name: '下载 3 项', exact: true }).click()
  await waitPendingAdd()
  await dialog.getByRole('button', { name: '停止添加', exact: true }).click()
  assert.equal(await dialog.getByRole('button', { name: '正在停止…', exact: true }).isDisabled(), true)
  await app.evaluate(() => globalThis.composerReview.pendingAdd())
  await dialog.locator('[data-batch-notice]').filter({ hasText: '已添加 1 项，其余 2 项已保留。' }).waitFor()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  assert.equal((await added()).filter(item => item.url.includes('/stop-')).length, 1, 'Stop must wait for the current acknowledgement without starting another item')
  await capture('06-stopped-batch')
  await app.evaluate(() => { globalThis.composerReview.holdAdd = false })
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await added()).filter(item => item.url.includes('/stop-')).length, 3)

  await app.evaluate(() => { globalThis.composerReview.holdClipboard = true })
  await open()
  await paste('https://fixtures.invalid/edited-one.zip\nhttps://fixtures.invalid/edited-two.pdf')
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.composerReview.pendingClipboard('https://fixtures.invalid/stale-clipboard.zip'); globalThis.composerReview.holdClipboard = false })
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await input.inputValue(), '', 'Late clipboard content must not overwrite a manually prepared batch')
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await app.evaluate(() => { globalThis.composerReview.clipboard = 'https://fixtures.invalid/next.zip\nhttps://fixtures.invalid/another.pdf' })
  await open()
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).waitFor()
  assert.equal((await added()).length, 7, 'Clipboard prefill must also remain a draft')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await app.evaluate(({ BrowserWindow }) => { globalThis.composerReview.clipboard = ''; BrowserWindow.getAllWindows()[0].setSize(740, 640) })
  await win.getByRole('button', { name: '切换侧栏', exact: true }).click()
  const sidebar = win.locator('#main-sidebar')
  await sidebar.waitFor({ state: 'visible' })
  assert.equal(await win.locator('.ndm-workspace').getAttribute('data-sidebar-mode'), 'open')
  await open()
  assert.equal(await sidebar.evaluate(element => getComputedStyle(element).visibility), 'hidden', 'An overlaid sidebar must not cover the draft at mobile widths')
  assert.equal(await win.locator('.ndm-workspace').getAttribute('data-sidebar-mode'), 'open', 'Opening the draft must preserve the user sidebar preference')
  await capture('07-sidebar-hidden-during-compose')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await sidebar.waitFor({ state: 'visible' })
  assert.equal(await win.locator('.ndm-workspace').getAttribute('data-sidebar-mode'), 'open')
  assert.deepEqual(errors, [])
  const report = { root, pasteRequiresConfirmation: true, removableDeduplicatedReview: true, partialFailuresRemain: true, successfulItemsNotRetried: true, explicitDestinationPreserved: true, ordinaryFileDuplicateVisible: true, editedFilenamePreserved: true, clipboardPrefillRequiresConfirmation: true, escapePreservesPendingRequest: true, stoppingBatchPreservesRemaining: true, lateClipboardPreservesEditedDraft: true, overlayInspectorRestored: true, overlaySidebarPreferencePreserved: true, rendererErrors: errors }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await app.close() }
