// Real Electron UI with an isolated fixture host; view CRUD must never mutate tasks.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const root = mkdtempSync('/tmp/ndm-saved-views-')
const now = Date.now()
const day = 86400000
const tasks = [
  [1, 'Design brief.pdf', 'error', 'document', now - 3600000],
  [2, 'Design guide.pdf', 'complete', 'document', now - day],
  [3, 'Assets.zip', 'error', 'compressed', now - 2 * day],
  [4, 'Archived design.pdf', 'error', 'document', now - 40 * day],
  [5, 'Media reference.mp4', 'error', 'video', now - 7200000],
  [6, 'Unknown time.pdf', 'error', 'document', undefined],
  [7, 'Ready guide.pdf', 'complete', 'document', now - 3 * day],
  [8, 'Draft release.pdf', 'error', 'document', now - 3600000],
  [9, 'Paused Design.pdf', 'paused', 'document', now - 3600000],
  [10, 'Paused assets.zip', 'paused', 'compressed', now - 3600000]
].map(([id, filename, status, category, activityAt]) => ({ id, filename, title: filename, status, category, activityAt, url: `https://example.com/files/${id}`, source: 'example.com', folderPath: root, fileSize: 4096, completedBytes: 4096, bytesPerSecond: 0, connections: 4, segments: [] }))
const requests = []
const actionCalls = []
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push(request.op)
      if (['restart', 'restartMany', 'resume'].includes(request.op)) actionCalls.push(request)
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: root, maxConnections: 4, maxConcurrentDownloads: 4, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, expectedRelayVersion: '2.0.0', relayClients: [] }
      socket.write(JSON.stringify(reply) + '\n')
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
try {
  const executablePath = process.env.NDM_QA_APP_PATH?.trim()
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${root}/electron`] } : { args: ['.', `--user-data-dir=${root}/electron`] }), env: { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.locator('[data-task-select="1"]').waitFor()
  const errors = []; win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  const popup = win.locator('[data-library-filters]')
  const views = win.getByRole('dialog', { name: '常用视图', exact: true })
  const readViews = () => win.evaluate(() => JSON.parse(localStorage.getItem('ndm-saved-views-v1') || '{}').views || [])
  const visibleIDs = () => win.locator('[data-task-select]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-task-select'))).sort((a, b) => a - b))
  const settled = () => win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const capture = async name => { await settled(); await win.waitForTimeout(220); await win.screenshot({ path: `${root}/${name}.png`, animations: 'disabled' }) }
  const openViews = async () => { await win.getByRole('button', { name: /^常用视图/ }).click(); await views.waitFor() }
  const openFilters = async () => { await win.getByRole('button', { name: '筛选下载任务', exact: true }).click(); await popup.waitFor() }
  const saveAs = async name => {
    await popup.getByRole('button', { name: '保存视图…', exact: true }).click()
    await popup.getByRole('textbox', { name: '视图名称', exact: true }).fill(name)
    await popup.getByRole('button', { name: '保存视图', exact: true }).click()
  }
  const headerTop = await win.locator('.task-table-header').evaluate(element => element.getBoundingClientRect().top)
  await capture('00-baseline-wide')
  await win.locator('#ndm-search').fill('Design')
  await openFilters()
  await popup.getByRole('combobox', { name: '筛选状态', exact: true }).selectOption('failed')
  await popup.getByRole('combobox', { name: '筛选类型', exact: true }).selectOption('document')
  await popup.getByRole('combobox', { name: '最近活动时间', exact: true }).selectOption('week')
  await saveAs('本周设计待重试')
  await popup.waitFor({ state: 'hidden' }); await settled()
  assert.deepEqual(await visibleIDs(), [1])
  assert.equal(await win.locator('[data-filter="failed"]').getAttribute('aria-pressed'), 'true')
  assert.equal(await win.locator('[data-filter="document"]').getAttribute('aria-pressed'), 'true')
  assert.equal(await win.locator('.task-table-header').evaluate(element => element.getBoundingClientRect().top), headerTop, 'Filter controls must not push the list down')
  await capture('01-saved-combination')
  for (const theme of ['walnut', 'dawn', 'noon']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await capture(`01-combination-${theme}`)
  }
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  assert.equal((await readViews()).length, 1)

  // Editing the current search exits the saved-view match without resetting other dimensions.
  await win.getByRole('button', { name: '清除搜索', exact: true }).click(); await settled()
  assert.deepEqual(await visibleIDs(), [1, 8])
  await openViews()
  assert.equal(await views.locator('[data-current]').count(), 0)
  await views.getByRole('button', { name: '打开视图：本周设计待重试', exact: true }).click()
  await views.waitFor({ state: 'hidden' }); await settled()
  assert.equal(await win.locator('#ndm-search').inputValue(), 'Design')
  assert.deepEqual(await visibleIDs(), [1])

  await win.getByRole('button', { name: '排序下载任务', exact: true }).click()
  await win.getByRole('menuitemradio', { name: '文件名 A → Z', exact: true }).click()
  if (await win.getByRole('menu').isVisible()) await win.keyboard.press('Escape')
  await openViews()
  assert.equal(await views.locator('[data-current]').count(), 0, 'Changing sort exits the saved-view match')
  await views.getByRole('button', { name: '打开视图：本周设计待重试', exact: true }).click()
  await views.waitFor({ state: 'hidden' })
  assert.equal(await win.evaluate(() => JSON.parse(localStorage.getItem('ndm-task-sort')).key), 'activity')

  await win.locator('[data-task-select="1"]').click()
  await openViews()
  await win.keyboard.press('Delete')
  assert.equal(await win.getByRole('alertdialog').count(), 0, 'Saved views dialog must own deletion keys instead of deleting a task underneath')
  await views.getByRole('button', { name: '重命名视图：本周设计待重试', exact: true }).click()
  const name = views.getByRole('textbox', { name: '重命名视图', exact: true })
  await name.fill('设计复查')
  await views.getByRole('button', { name: '保存', exact: true }).click()
  await views.getByRole('button', { name: '打开视图：设计复查', exact: true }).waitFor()
  await capture('02-managed-views')
  for (const theme of ['walnut', 'dawn', 'noon']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await capture(`02-managed-${theme}`)
  }
  await views.getByRole('button', { name: '关闭常用视图', exact: true }).click()

  // Reload the renderer to verify persisted data instead of reading React state only.
  await win.reload(); await win.waitForLoadState('domcontentloaded'); await win.locator('[data-task-select="1"]').waitFor()
  await openViews()
  await views.getByRole('button', { name: '打开视图：设计复查', exact: true }).click()
  await views.waitFor({ state: 'hidden' }); await settled()
  assert.deepEqual(await visibleIDs(), [1])
  await win.locator('[data-filter="all"]').click(); await settled()
  assert.equal(await win.locator('#ndm-search').inputValue(), '')
  assert.equal((await visibleIDs()).length, tasks.length)
  await openFilters()
  assert.equal(await popup.getByRole('combobox', { name: '筛选状态' }).inputValue(), 'all')
  assert.equal(await popup.getByRole('combobox', { name: '筛选类型' }).inputValue(), 'all')
  assert.equal(await popup.getByRole('combobox', { name: '最近活动时间' }).inputValue(), 'any')

  // A duplicate name stays recoverable and a storage error must not pretend to save.
  await saveAs('设计复查')
  await popup.getByText('已有同名视图，请换一个名字。', { exact: true }).waitFor()
  await popup.getByRole('textbox', { name: '视图名称' }).fill('全部项目')
  await win.evaluate(() => { window.savedViewSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === 'ndm-saved-views-v1') throw new DOMException('Quota exceeded', 'QuotaExceededError'); return window.savedViewSetItem.call(this, key, value) } })
  await popup.getByRole('button', { name: '保存视图', exact: true }).click()
  await popup.getByText('未能保存视图，请重试。', { exact: true }).waitFor()
  assert.equal((await readViews()).length, 1)
  await win.evaluate(() => { Storage.prototype.setItem = window.savedViewSetItem })
  await popup.getByRole('button', { name: '保存视图', exact: true }).click()
  await popup.waitFor({ state: 'hidden' })
  assert.equal((await readViews()).length, 2)

  // Rename validation belongs to the current form, not the whole manager.
  await openViews()
  await views.getByRole('button', { name: '重命名视图：设计复查', exact: true }).click()
  await name.fill('全部项目')
  await views.getByRole('button', { name: '保存', exact: true }).click()
  await views.getByText('已有同名视图，请换一个名字。', { exact: true }).waitFor()
  await views.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await views.getByRole('status').count(), 0, 'Cancel must dismiss the abandoned rename error')
  await views.getByRole('button', { name: '重命名视图：设计复查', exact: true }).click()
  assert.equal(await views.getByRole('status').count(), 0, 'A new edit must start without an old validation error')

  // Dismissing a failed attempt must not hide the same persistence failure on retry.
  await win.evaluate(() => { Storage.prototype.setItem = function (key, value) { if (key === 'ndm-saved-views-v1') throw new DOMException('Quota exceeded', 'QuotaExceededError'); return window.savedViewSetItem.call(this, key, value) } })
  await name.fill('设计检查')
  await views.getByRole('button', { name: '保存', exact: true }).click()
  await views.getByText('未能保存视图，请重试。', { exact: true }).waitFor()
  assert.deepEqual((await readViews()).map(view => view.name), ['设计复查', '全部项目'], 'A failed write must preserve the stored names')
  await capture('02b-rename-storage-error')
  await views.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await views.getByRole('status').count(), 0, 'Cancel must dismiss a failed attempt without changing the saved view')
  await views.getByRole('button', { name: '重命名视图：全部项目', exact: true }).click()
  assert.equal(await views.getByRole('status').count(), 0, 'Editing another view must not inherit a dismissed error')
  await name.fill('全部资料')
  await views.getByRole('button', { name: '保存', exact: true }).click()
  await views.getByText('未能保存视图，请重试。', { exact: true }).waitFor()
  assert.deepEqual((await readViews()).map(view => view.name), ['设计复查', '全部项目'])
  await name.fill('全部项目')
  assert.equal(await views.getByRole('status').count(), 0, 'Changing the form clears its last attempt error')
  await win.evaluate(() => { Storage.prototype.setItem = window.savedViewSetItem })
  await views.getByRole('button', { name: '保存', exact: true }).click()
  await views.getByRole('button', { name: '打开视图：全部项目', exact: true }).waitFor()
  assert.equal(await views.getByRole('status').count(), 0)
  await capture('02c-rename-error-recovered')
  await views.getByRole('button', { name: '关闭常用视图', exact: true }).click()

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 640))
  await openFilters()
  assert.equal(await popup.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }), true)
  await capture('03-narrow-filters')
  for (const theme of ['walnut', 'dawn', 'noon']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await capture(`03-narrow-${theme}`)
  }
  await popup.getByRole('button', { name: '关闭筛选', exact: true }).click()
  // Restore sidebar after the width breakpoint so the single entry remains reachable.
  if (!await win.getByRole('button', { name: /^常用视图/ }).isVisible()) await win.getByRole('button', { name: '切换侧栏', exact: true }).click()
  await openViews()
  await views.getByRole('button', { name: '移除视图：设计复查', exact: true }).click()
  assert.equal(await views.getByRole('button', { name: '打开视图：设计复查', exact: true }).count(), 0)
  await views.getByRole('button', { name: '移除视图：全部项目', exact: true }).click()
  await views.getByText('把常找的下载放在手边', { exact: true }).waitFor()
  assert.deepEqual(await readViews(), [])
  await capture('04-empty-views')
  assert.equal(tasks.length, 10)
  assert.deepEqual(requests.filter(op => ['add', 'remove', 'removeMany', 'restart', 'restartMany', 'pause', 'resume', 'clearHistory'].includes(op)), [], 'Managing views must not change download records')
  await views.getByRole('button', { name: '关闭常用视图', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  await win.locator('[data-filter="all"]').click()
  await win.locator('#ndm-search').fill('Design')
  await openFilters()
  await popup.getByRole('combobox', { name: '筛选状态' }).selectOption('failed')
  await popup.getByRole('combobox', { name: '筛选类型' }).selectOption('document')
  await popup.getByRole('combobox', { name: '最近活动时间' }).selectOption('week')
  await win.keyboard.press('Delete')
  assert.equal(await win.getByRole('alertdialog').count(), 0)
  await win.keyboard.press('Escape')
  await popup.waitFor({ state: 'hidden' })
  await win.getByRole('button', { name: '重试这 1 项', exact: true }).click()
  for (let i = 0; i < 30 && !actionCalls.length; i++) await win.waitForTimeout(50)
  assert.deepEqual(actionCalls.map(request => [request.op, request.taskID]), [['restart', 1]])
  await win.locator('[data-filter="paused"]').click()
  await win.getByRole('button', { name: '继续这 1 项', exact: true }).click()
  for (let i = 0; i < 30 && actionCalls.length < 2; i++) await win.waitForTimeout(50)
  assert.deepEqual(actionCalls.map(request => [request.op, request.taskID]), [['restart', 1], ['resume', 9]], 'Bulk actions must affect only matching visible tasks')
  assert.deepEqual(errors, [])
  const report = { root, combinedStatusTypeQueryTime: true, noExtraHeaderRow: true, savedFiltersPersistAcrossReload: true, editedCriteriaAndSortExitActiveView: true, renameAndRemove: true, allResetsEveryCondition: true, duplicateAndStorageErrorsRecover: true, renameCancelClearsError: true, repeatedStorageFailureStaysVisible: true, failedRenamePreservesNames: true, narrowPopupFits: true, managingViewsLeavesTaskRecordsUntouched: true, bulkActionsUseVisibleIDs: true, modalKeyboardIsolated: true, rendererErrors: errors }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
