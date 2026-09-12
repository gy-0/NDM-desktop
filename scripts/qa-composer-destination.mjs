// Real Electron renderer; controlled IPC ordering, no real file chooser or downloads.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const root = mkdtempSync(join(tmpdir(), 'ndm-composer-destination-'))
const launch = qaLaunchOptions('composer-destination')
const app = await electron.launch(launch)
let win
try {
  win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded')
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain }) => {
    globalThis.destinationQA = { settings: [], folders: [], added: [], draftOperations: [] }
    const originalRequest = ipcMain._invokeHandlers.get('engine:request')
    if (typeof originalRequest !== 'function') throw new Error('Missing production engine request handler')
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', async (event, op, args) => {
      const q = globalThis.destinationQA
      if (['composerDraftLoad', 'composerDraftSave', 'composerDraftDiscard', 'composerDraftFlushResult'].includes(op)) {
        const reply = await originalRequest(event, op, args)
        q.draftOperations.push({ op, ok: reply.ok, revision: reply.revision })
        return reply
      }
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
    ipcMain.removeHandler('system:clipboard-snapshot'); ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0, selfWritten: false }))
  })
  // A fresh onboarding keeps clipboard offers inactive until the synthetic
  // handlers are installed. Never inspect or change the user's pasteboard.
  await completeOnboarding(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  const dialog = win.getByRole('dialog', { name: '添加下载', exact: true })
  const open = async () => { await win.keyboard.press('Meta+n'); await dialog.waitFor() }
  const waitPending = async key => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await app.evaluate((_electron, key) => globalThis.destinationQA[key].length > 0, key)) return
      await win.waitForTimeout(50)
    }
    throw new Error(`Expected controlled ${key} request`)
  }
  const resolveSettings = async path => app.evaluate((_electron, path) => {
    const pending = globalThis.destinationQA.settings.splice(0)
    for (const resolve of pending) resolve({ settings: { downloadDirectory: path, maxConnections: 32 } })
  }, path)
  const chooseButton = dialog.getByRole('button', { name: '更改保存位置', exact: true })
  const choose = async () => { await chooseButton.click(); await waitPending('folders') }
  const destination = path => dialog.locator('[data-composer-destination]').getByTitle(path, { exact: true })
  await open()
  // Baseline also supports this test once its options are expanded.
  const visibleInitially = await chooseButton.isVisible()
  if (!visibleInitially) await win.getByRole('button', { name: '选项', exact: true }).click()
  await choose()
  await app.evaluate(() => globalThis.destinationQA.folders.shift()('/tmp/NDM Project A'))
  await destination('/tmp/NDM Project A').waitFor()
  if (visibleInitially) await win.getByRole('button', { name: '选项', exact: true }).click()
  await win.getByRole('group', { name: '分段连接' }).getByRole('button', { name: '8', exact: true }).click()
  await waitPending('settings')
  await resolveSettings('/tmp/default-downloads')
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await destination('/tmp/NDM Project A').count(), 1, 'Late defaults must not overwrite the explicit destination')
  assert.equal(await destination('/tmp/NDM Project A').textContent(), '/tmp/NDM Project A', 'The parent/name spans must retain the complete selected path')
  assert.equal(visibleInitially, true, 'Destination must be visible before expanding advanced options')
  assert.equal(await win.getByRole('group', { name: '分段连接' }).getByRole('button', { name: '8', exact: true }).getAttribute('aria-pressed'), 'true')
  const fits = await win.locator('[data-composer-destination]').evaluate(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
  })
  assert.ok(fits, 'Destination must fit the compact window')
  await win.screenshot({ path: `${root}/01-explicit-destination.png` })
  await win.getByRole('textbox', { name: '下载链接', exact: true }).fill('https://fixture.invalid/file.bin')
  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await win.getByRole('dialog', { name: '添加下载', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await app.evaluate(() => globalThis.destinationQA.added[0]?.folderPath), '/tmp/NDM Project A')
  assert.equal(await app.evaluate(() => globalThis.destinationQA.added[0]?.connections), 8)
  await open(); await choose()
  await win.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await open()
  await waitPending('settings')
  await resolveSettings('/tmp/new-default')
  await destination('/tmp/new-default').waitFor()
  await app.evaluate(() => globalThis.destinationQA.folders.shift()('/tmp/stale-project'))
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await destination('/tmp/new-default').count(), 1, 'Old chooser response must not mutate a new Composer session')
  assert.equal(await destination('/tmp/stale-project').count(), 0)
  await win.screenshot({ path: `${root}/02-stale-chooser-ignored.png` })
  const draftOperations = await app.evaluate(() => globalThis.destinationQA.draftOperations)
  assert.ok(draftOperations.some(item => item.op === 'composerDraftLoad' && item.ok === true && Number.isSafeInteger(item.revision)), 'Load must use the real durable draft protocol')
  assert.ok(draftOperations.every(item => item.ok === true))
  assert.deepEqual(errors, [])
  const report = { root, supportDirectory: launch.env.NDM_SUPPORT_DIR, passed: true, method: 'Real Electron renderer, controlled settings/chooser/add IPC, original encrypted draft handler; synthetic clipboard installed before onboarding completes.', visibleInitially, completePathPreserved: true, explicitDestinationSubmitted: true, explicitEightConnectionsSubmitted: true, lateSettingsIgnored: true, staleChooserIgnored: true, compactDestinationFits: fits, draftOperations, rendererErrors: errors }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  await win?.screenshot({ path: `${root}/failure.png` }).catch(() => undefined)
  writeFileSync(`${root}/failure.json`, JSON.stringify({ root, error: error.message }, null, 2))
  console.error(`Composer destination QA evidence: ${root}`)
  throw error
} finally { await app.close() }
