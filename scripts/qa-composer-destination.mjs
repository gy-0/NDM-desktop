// Real Electron renderer; controlled IPC ordering, no real file chooser or downloads.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app = await electron.launch(qaLaunchOptions('composer-destination'))
try {
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await app.evaluate(({ ipcMain }) => {
    globalThis.destinationQA = { settings: [], folders: [], added: [] }
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_event, op, args) => {
      const q = globalThis.destinationQA
      if (op === 'getSettings') return new Promise(resolve => q.settings.push(resolve))
      if (op === 'add') { q.added.push(args); return { ok: true, task: { id: 998881, url: args.url, filename: 'fixture.bin', status: 'waiting', folderPath: args.folderPath } } }
      if (op === 'list') return { ok: true, tasks: [] }
      return { ok: true }
    })
    ipcMain.removeHandler('dialog:select-folder')
    ipcMain.handle('dialog:select-folder', () => new Promise(resolve => globalThis.destinationQA.folders.push(resolve)))
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', () => ({ kind: 'binary', contentType: 'application/octet-stream', contentLength: 4096, disposition: null }))
    ipcMain.removeHandler('system:read-clipboard'); ipcMain.handle('system:read-clipboard', () => '')
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  const open = async () => { await win.keyboard.press('Meta+n'); await win.getByRole('dialog', { name: '添加下载', exact: true }).waitFor() }
  const resolveSettings = async path => app.evaluate((_electron, path) => {
    const pending = globalThis.destinationQA.settings.splice(0)
    for (const resolve of pending) resolve({ settings: { downloadDirectory: path, maxConnections: 32 } })
  }, path)
  const choose = () => win.getByRole('button', { name: /^(浏览|更改保存位置)$/ }).click()
  await open()
  // Baseline also supports this test once its options are expanded.
  const visibleInitially = await win.getByRole('button', { name: /^(浏览|更改保存位置)$/ }).isVisible()
  if (!visibleInitially) await win.getByRole('button', { name: '选项', exact: true }).click()
  await choose()
  await app.evaluate(() => globalThis.destinationQA.folders.shift()('/tmp/NDM Project A'))
  await win.getByText('/tmp/NDM Project A', { exact: true }).waitFor()
  if (visibleInitially) await win.getByRole('button', { name: '选项', exact: true }).click()
  await win.getByRole('group', { name: '分段连接' }).getByRole('button', { name: '8', exact: true }).click()
  await resolveSettings('/tmp/default-downloads')
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await win.getByText('/tmp/NDM Project A', { exact: true }).count(), 1, 'Late defaults must not overwrite the explicit destination')
  assert.equal(visibleInitially, true, 'Destination must be visible before expanding advanced options')
  assert.equal(await win.getByRole('group', { name: '分段连接' }).getByRole('button', { name: '8', exact: true }).getAttribute('aria-pressed'), 'true')
  const fits = await win.locator('[data-composer-destination]').evaluate(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
  })
  assert.ok(fits, 'Destination must fit the compact window')
  await win.screenshot({ path: '/tmp/ndm-composer-destination.png' })
  await win.getByRole('textbox', { name: '下载链接', exact: true }).fill('https://fixture.invalid/file.bin')
  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await win.getByRole('dialog', { name: '添加下载', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await app.evaluate(() => globalThis.destinationQA.added[0]?.folderPath), '/tmp/NDM Project A')
  assert.equal(await app.evaluate(() => globalThis.destinationQA.added[0]?.connections), 8)
  await open(); await choose()
  await win.keyboard.press('Escape')
  await open()
  await resolveSettings('/tmp/new-default')
  await win.getByText('/tmp/new-default', { exact: true }).waitFor()
  await app.evaluate(() => globalThis.destinationQA.folders.shift()('/tmp/stale-project'))
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await win.getByText('/tmp/new-default', { exact: true }).count(), 1, 'Old chooser response must not mutate a new Composer session')
  assert.equal(await win.getByText('/tmp/stale-project', { exact: true }).count(), 0)
  console.log(JSON.stringify({ visibleInitially, explicitDestinationSubmitted: true, lateSettingsIgnored: true, staleChooserIgnored: true }))
} finally { await app.close() }
