// Real Electron + native Host with isolated state and real loopback downloads.
// Only clipboard, chooser, and selected IPC timing/failure boundaries are controlled.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const payload = Buffer.alloc(65536, 0x6e)
const server = createServer((request, response) => {
  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = Number(range?.[1] || 0), end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, end + 1)
  response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': body.length,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  response.end(request.method === 'HEAD' ? undefined : body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const options = qaLaunchOptions('composer-draft')
const root = options.env.NDM_SUPPORT_DIR.replace(/\/engine$/, '')
const folder = `${root}/Design assets`
mkdirSync(folder, { recursive: true })
const url = name => `http://127.0.0.1:${server.address().port}/${name}`
const errors = [], checks = []
let app, win, dialog, input
const capture = async name => win.screenshot({ path: `${root}/${name}.png`, animations: 'disabled' })
async function launch({ failLoad = false } = {}) {
  app = await electron.launch(options)
  app.process().stdout.on('data', data => appendFileSync(`${root}/process.log`, data))
  app.process().stderr.on('data', data => appendFileSync(`${root}/process.log`, data))
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain, BrowserWindow }, { folder, failLoad }) => {
    const q = globalThis.draftQA = { failLoad, failSave: false, holdAdd: false, pendingAdd: null,
      holdDiscard: false, pendingDiscard: null, added: [], operations: [], clipboard: '', folder }
    const handler = ipcMain._invokeHandlers.get('engine:request')
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', async (event, op, args) => {
      if (op === 'composerDraftLoad' && q.failLoad) { q.failLoad = false; return { ok: false, code: 'readFailed', error: '暂时无法读取已保存的清单，原记录已保留。' } }
      if (op === 'composerDraftSave' && q.failSave) return { ok: false, code: 'writeFailed', error: '清单未能保存，请稍后重试。' }
      let reply
      try { reply = await handler(event, op, args) }
      catch (error) { q.operations.push({ op, error: error.message }); throw error }
      if (['add', 'getCreationReceipt'].includes(op)) q.operations.push({ op, reply })
      if (op === 'add') {
        q.added.push({ args, reply })
        if (q.holdAdd) { q.holdAdd = false; return new Promise(resolve => { q.pendingAdd = () => { q.pendingAdd = null; resolve(reply) } }) }
      }
      if (op === 'composerDraftDiscard' && q.holdDiscard) {
        q.holdDiscard = false
        return new Promise(resolve => { q.pendingDiscard = () => { q.pendingDiscard = null; resolve(reply) } })
      }
      return reply
    })
    ipcMain.removeHandler('system:read-clipboard'); ipcMain.handle('system:read-clipboard', () => q.clipboard)
    ipcMain.removeHandler('system:clipboard-snapshot'); ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0, selfWritten: false }))
    ipcMain.removeHandler('dialog:select-folder'); ipcMain.handle('dialog:select-folder', () => folder)
    ipcMain.removeHandler('system:classify-url'); ipcMain.handle('system:classify-url', () => ({ kind: 'binary', contentType: 'application/octet-stream' }))
    BrowserWindow.getAllWindows()[0].setSize(1160, 820)
  }, { folder, failLoad })
  await completeOnboarding(win)
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await win.evaluate(async () => { try { return Array.isArray((await window.ndm.request('list')).tasks) } catch { return false } })
    if (ready) break
    await win.waitForTimeout(100)
  }
  assert.ok(ready, 'Native Host must answer a real RPC before testing')
  dialog = win.getByRole('dialog', { name: '添加下载', exact: true })
  input = win.getByRole('textbox', { name: '下载链接', exact: true })
}
async function open() { await win.getByRole('button', { name: '添加下载', exact: true }).first().click(); await dialog.waitFor(); await input.waitFor(); await win.waitForFunction(() => !document.querySelector('input[aria-label="下载链接"]')?.disabled) }
async function paste(text) { await input.evaluate((element, text) => {
  const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
}, text) }
const readDraft = () => win.evaluate(async () => window.ndm.request('composerDraftLoad'))
const taskList = () => win.evaluate(async () => (await window.ndm.request('list')).tasks)
async function closeForRestart() {
  await app.close(); app = null
  for (let attempt = 0; attempt < 100; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(options.env.NDM_HOST_PORT) })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (!listening) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Previous isolated Host did not stop before restart')
}
async function waitSaved() { await dialog.getByText('清单已保存在本机', { exact: true }).waitFor() }
async function waitMain(test) {
  for (let attempt = 0; attempt < 120; attempt++) { if (await app.evaluate(test)) return; await win.waitForTimeout(50) }
  throw new Error('Main-process QA condition timed out')
}
async function incoming(link) {
  await win.evaluate(() => {
    window.__draftQAIncoming = false
    const stop = window.ndm.onEvent(message => {
      if (message.op === 'openMediaComposer') { window.__draftQAIncoming = true; stop() }
    })
  })
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'openMediaComposer', url }), link)
  await win.waitForFunction(() => window.__draftQAIncoming)
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function waitTaskCount(count) {
  await win.waitForFunction(async count => {
    const { tasks } = await window.ndm.request('list')
    return tasks.length === count && tasks.every(task => task.status === 'complete')
  }, count)
}
try {
  await launch()
  await win.evaluate(async folder => window.ndm.request('updateSettings', { downloadDirectory: folder, useCategoryFolders: false, maxConnections: 4, smartConnections: false }), folder)
  await open()
  await paste([url('Design-Kit.zip'), url('Field-Notes.pdf'), url('remove.bin')].join('\n'))
  await dialog.getByRole('button', { name: '移除第 3 项：remove.bin', exact: true }).click()
  await dialog.getByRole('button', { name: /^(浏览|更改保存位置)$/ }).click()
  await dialog.getByRole('button', { name: '选项', exact: true }).click()
  await dialog.getByRole('group', { name: '分段连接' }).getByRole('button', { name: '8', exact: true }).click()
  await input.fill(url('unreviewed.bin'))
  await waitSaved()
  await win.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  await app.evaluate(() => { globalThis.draftQA.clipboard = 'https://clipboard.invalid/replace.bin' })
  await open()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  assert.equal(await input.inputValue(), url('unreviewed.bin'))
  assert.equal((await readDraft()).draft.connections.value, 8)
  assert.equal((await taskList()).length, 0)
  await capture('01-restored')
  checks.push('close preserves reviewed list, explicit options and input; clipboard never replaces it')
  await closeForRestart()
  await launch({ failLoad: true }); await open()
  await dialog.locator('[data-draft-error]').waitFor()
  await dialog.locator('[data-draft-error]').getByRole('button', { name: '重试', exact: true }).click()
  await dialog.locator('[data-batch-link]').first().waitFor()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  assert.equal(await input.inputValue(), url('unreviewed.bin'))
  checks.push('real application restart and retry after transient read failure restore the encrypted draft')
  await input.fill('')
  await waitSaved()
  await app.evaluate(() => { globalThis.draftQA.holdAdd = true })
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
  await waitMain(() => Boolean(globalThis.draftQA.pendingAdd))
  assert.equal((await readDraft()).draft.items[0].status, 'unconfirmed')
  assert.equal((await taskList()).length, 1)
  await win.reload(); await win.waitForLoadState('domcontentloaded'); await open()
  await dialog.getByRole('button', { name: /^(确认添加结果|确认 \d+ 项)$/ }).click()
  await win.waitForFunction(() => document.querySelectorAll('[data-batch-link]').length === 1)
  assert.equal((await taskList()).length, 1)
  await app.evaluate(() => globalThis.draftQA.pendingAdd?.())
  await capture('02-confirmed-without-duplicate')
  checks.push('renderer reload after actual creation before acknowledgement reconciles receipt without creating another task')
  await app.evaluate(() => { globalThis.draftQA.holdAdd = true })
  await dialog.getByRole('button', { name: '下载 1 项', exact: true }).click()
  await waitMain(() => Boolean(globalThis.draftQA.pendingAdd))
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'openMediaComposer', url }), url('incoming.bin'))
  await win.waitForTimeout(100)
  await app.evaluate(() => globalThis.draftQA.pendingAdd?.())
  await win.waitForFunction(() => document.querySelector('input[aria-label="下载链接"]')?.value.endsWith('/incoming.bin'))
  assert.equal(await dialog.isVisible(), true)
  assert.equal((await taskList()).length, 2)
  await waitSaved()
  assert.equal((await readDraft()).draft.input, url('incoming.bin'))
  checks.push('incoming browser link stays reviewable while a prior batch finishes; no hidden automatic download')
  await dialog.getByRole('button', { name: '加入清单', exact: true }).click()
  await waitSaved()
  await app.evaluate(() => { globalThis.draftQA.failSave = true })
  await input.fill(url('unsaved.bin'))
  await dialog.locator('[data-draft-error]').waitFor()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal(await dialog.isVisible(), true)
  await app.evaluate(({ app }) => app.quit())
  await win.waitForTimeout(500)
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await win.evaluate(async () => window.ndm.status()), 'live')
  assert.equal((await taskList()).length, 2)
  checks.push('failed save blocks close and quit while keeping the application and engine responsive')
  await app.evaluate(() => { globalThis.draftQA.failSave = false })
  await dialog.locator('[data-draft-error]').getByRole('button', { name: '重试', exact: true }).click()
  await waitSaved()
  assert.equal(await win.getByTestId('completion-bar').count(), 0, 'Completion popovers must yield to the active draft')
  for (const theme of ['dawn', 'walnut', 'noon']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await capture(`03-${theme}`)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 600))
  await capture('04-compact')
  const fits = await dialog.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
  assert.ok(fits, 'Draft actions fit the smallest supported window')
  const completedDraftID = (await readDraft()).draft.id
  await input.fill('')
  await dialog.getByRole('button', { name: '下载 1 项', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await win.waitForFunction(async () => { const { tasks } = await window.ndm.request('list'); return tasks.length === 3 && tasks.every(task => task.status === 'complete') })
  const firstTasks = await taskList()
  assert.equal(new Set(firstTasks.map(task => task.url)).size, 3)
  for (const task of firstTasks) assert.deepEqual(readFileSync(`${folder}/${task.filename}`), payload)
  assert.equal((await readDraft()).draft, null)
  checks.push('all three actual artifacts have expected bytes, exactly one task per URL, finished draft cleared')

  // A completed draft is retired. The next review must use a fresh identifier,
  // rather than repeatedly trying to write the discarded generation.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1160, 820))
  await open()
  await paste([url('Second-Batch-A.zip'), url('Second-Batch-B.pdf')].join('\n'))
  await waitSaved()
  const secondDraft = (await readDraft()).draft
  assert.notEqual(secondDraft.id, completedDraftID, 'A new batch cannot reuse the discarded draft ID')
  assert.equal(secondDraft.items.length, 2)
  await capture('05-second-batch')
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await waitTaskCount(5)
  assert.equal((await readDraft()).draft, null)
  checks.push('a fully completed review can be followed by a second saved and submitted batch in the same renderer')

  // Loading fails before hydration. Both new pasted rows and unreviewed typing
  // must survive the eventual merge with the real encrypted saved draft.
  await open()
  await paste([url('Saved-A.zip'), url('Saved-B.pdf')].join('\n'))
  await input.fill(url('saved-input.bin'))
  await waitSaved()
  await closeForRestart()
  await launch({ failLoad: true }); await open()
  await dialog.locator('[data-draft-error]').waitFor()
  await paste([url('Edited-C.zip'), url('Edited-D.pdf')].join('\n'))
  await input.fill(url('edited-input.bin'))
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  await dialog.locator('[data-draft-error]').getByRole('button', { name: '重试', exact: true }).click()
  await win.waitForFunction(() => document.querySelectorAll('[data-batch-link]').length === 4)
  await waitSaved()
  const mergedDraft = (await readDraft()).draft
  assert.deepEqual(mergedDraft.items.map(item => item.url), ['Saved-A.zip', 'Saved-B.pdf', 'Edited-C.zip', 'Edited-D.pdf'].map(url))
  assert.ok((await input.inputValue()).includes(url('saved-input.bin')))
  assert.ok((await input.inputValue()).includes(url('edited-input.bin')))
  assert.equal(mergedDraft.input, await input.inputValue())
  assert.equal((await taskList()).length, 5, 'Restoring edited draft must not create downloads')
  await capture('06-load-retry-keeps-edits')
  checks.push('retry after initial read failure retains saved rows/input and newly pasted rows/typed input without downloading')
  await dialog.getByRole('button', { name: '丢弃清单', exact: true }).click()
  await win.waitForFunction(() => !document.querySelector('[data-batch-link]') && document.querySelector('input[aria-label="下载链接"]')?.value === '')
  await win.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })

  // A single URL plus an incoming browser URL is now a multi-link review. A
  // single-item submit must not silently consume only the first URL.
  await open()
  await paste(url('Single-A.zip'))
  assert.equal(await dialog.locator('[data-batch-link]').count(), 0)
  await incoming(url('Incoming-B.pdf'))
  const join = dialog.getByRole('button', { name: '加入清单', exact: true })
  await join.waitFor()
  assert.ok((await input.inputValue()).includes(url('Single-A.zip')))
  assert.ok((await input.inputValue()).includes(url('Incoming-B.pdf')))
  assert.equal((await taskList()).length, 5)
  await join.click()
  await win.waitForFunction(() => document.querySelectorAll('[data-batch-link]').length === 2)
  assert.equal(await input.inputValue(), '')
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).waitFor()
  await waitSaved()
  assert.deepEqual((await readDraft()).draft.items.map(item => item.url), [url('Single-A.zip'), url('Incoming-B.pdf')])
  await capture('07-single-plus-incoming')
  checks.push('single-link input plus a browser link becomes an explicit two-item review without hidden creation')

  // Hold the final discard ACK after it has committed. A new incoming link in
  // that exact completion window must be preserved in a fresh draft, not closed.
  const retiringDraftID = (await readDraft()).draft.id
  await app.evaluate(() => { globalThis.draftQA.holdDiscard = true })
  await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
  await waitMain(() => Boolean(globalThis.draftQA.pendingDiscard))
  assert.equal((await readDraft()).draft, null, 'Held boundary is after the native persistence discard commit')
  await incoming(url('After-Discard.bin'))
  await app.evaluate(() => globalThis.draftQA.pendingDiscard?.())
  await win.waitForFunction(() => document.querySelector('input[aria-label="下载链接"]')?.value.includes('/After-Discard.bin'))
  assert.equal(await dialog.isVisible(), true)
  await waitSaved()
  const afterDiscard = (await readDraft()).draft
  assert.notEqual(afterDiscard.id, retiringDraftID)
  assert.equal(afterDiscard.input, url('After-Discard.bin'))
  assert.deepEqual(afterDiscard.items, [])
  await waitTaskCount(7)
  assert.ok(!(await taskList()).some(task => task.url === url('After-Discard.bin')))
  await capture('08-incoming-during-final-discard')
  checks.push('browser link arriving during final discard acknowledgement survives in a fresh editable draft')
  await dialog.getByRole('button', { name: '丢弃清单', exact: true }).click()
  await win.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  const tasks = await taskList()
  assert.equal(tasks.length, 7)
  assert.equal(new Set(tasks.map(task => task.url)).size, 7)
  for (const task of tasks) assert.deepEqual(readFileSync(`${folder}/${task.filename}`), payload)
  assert.equal((await readDraft()).draft, null)
  assert.deepEqual(errors, [])
  const report = { root, checks, fits, tasks: tasks.map(({ id, filename, connections }) => ({ id, filename, connections })), errors }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) { if (win) await capture('failure').catch(() => {}); console.error({ root, checks, operations: await app?.evaluate(() => globalThis.draftQA?.operations).catch(() => []) }); throw error }
finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
