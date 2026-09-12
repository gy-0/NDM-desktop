// Real native acknowledgements with one intentionally delayed renderer row.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const payload = Buffer.alloc(8 * 1024 * 1024, 0x61)
const server = createServer((request, response) => {
  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = Number(range?.[1] || 0), end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, end + 1)
  response.writeHead(range ? 206 : 200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (request.method === 'HEAD') { response.end(); return }
  let cursor = 0
  const timer = setInterval(() => {
    if (response.destroyed) return
    response.write(body.subarray(cursor, cursor + 32768)); cursor += 32768
    if (cursor >= body.length) response.end()
  }, 100)
  response.on('close', () => clearInterval(timer))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const options = qaLaunchOptions('selected-stale-snapshot')
const root = options.env.NDM_SUPPORT_DIR.replace(/\/engine$/, '')
let app
try {
  app = await electron.launch(options)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  const directory = `${root}/downloads`; mkdirSync(directory, { recursive: true })
  await win.evaluate(async directory => window.ndm.request('updateSettings', { downloadDirectory: directory, useCategoryFolders: false, maxConnections: 1, maxConcurrentDownloads: 2, smartConnections: false }), directory)
  const ids = []
  for (const filename of ['Held-a.bin', 'Held-b.bin']) {
    const reply = await win.evaluate(async options => window.ndm.request('add', options), {
      url: `http://127.0.0.1:${server.address().port}/${filename}`, filename, autoStart: false
    })
    ids.push(reply.task.id)
    await win.locator(`[data-task-select="${reply.task.id}"]`).waitFor()
  }
  // Capture actual IPC operations/acks. Only the asynchronous display snapshot
  // is held back; list and mutation requests still reach the real native host.
  await app.evaluate(({ BrowserWindow, ipcMain }, staleID) => {
    const state = globalThis.selectedSnapshotQA = { operations: [], phase: 'resume', staleID }
    const handler = ipcMain._invokeHandlers.get('engine:request')
    if (typeof handler !== 'function') throw new Error('QA could not find the existing engine request handler')
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', async (event, op, params) => {
      const reply = await handler(event, op, params)
      if (['pause', 'resume', 'list'].includes(op)) state.operations.push({ phase: state.phase, op, taskID: params?.taskID, ok: reply?.ok })
      return reply
    })
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel === 'engine:event' && args[0]?.op === 'snapshot') {
        args[0] = { ...args[0], tasks: args[0].tasks.map(task => task.id === staleID ? { ...task, status: 'paused' } : task) }
      }
      return send(channel, ...args)
    }
  }, ids[1])
  await win.locator(`[data-task-select="${ids[0]}"]`).click()
  await win.locator(`[data-task-select="${ids[1]}"]`).click({ modifiers: ['Meta'] })
  const toolbar = win.getByRole('toolbar', { name: '批量任务操作' })
  await toolbar.getByRole('button', { name: '继续所选', exact: true }).click()
  await win.waitForFunction(async ids => {
    const { tasks } = await window.ndm.request('list')
    return ids.every(id => tasks.find(task => task.id === id)?.status === 'downloading')
  }, ids)
  await toolbar.getByRole('button', { name: '暂停所选', exact: true }).waitFor()
  await win.waitForFunction(() => document.querySelector('[aria-label="批量任务操作"]')?.getAttribute('aria-busy') === 'false')
  // Both buttons show because one cached row is paused while the other is running.
  assert.equal(await toolbar.getByRole('button', { name: '继续所选', exact: true }).isVisible(), true)
  await win.screenshot({ path: `${root}/stale-before-pause.png`, animations: 'disabled' })
  await app.evaluate(() => { globalThis.selectedSnapshotQA.phase = 'pause' })
  await toolbar.getByRole('button', { name: '暂停所选', exact: true }).click()
  await win.waitForFunction(() => document.querySelector('[aria-label="批量任务操作"]')?.getAttribute('aria-busy') === 'false')
  const operations = await app.evaluate(() => globalThis.selectedSnapshotQA.operations)
  const fresh = await win.evaluate(async () => window.ndm.request('list'))
  const statuses = ids.map(id => fresh.tasks.find(task => task.id === id)?.status)
  const pauseOperations = operations.filter(item => item.phase === 'pause')
  const report = { root, ids, statuses, operations, pauseOperations }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  assert.deepEqual(operations.filter(item => item.op === 'resume').map(item => item.taskID).sort(), [...ids].sort())
  assert.deepEqual(pauseOperations.filter(item => item.op === 'pause' && item.ok).map(item => item.taskID).sort(), [...ids].sort(), 'Every actually running selected row must receive pause despite the held display snapshot')
  assert.equal(pauseOperations.filter(item => item.op === 'list').length, 1, 'One authoritative list per batch, never one per row')
  assert.deepEqual(statuses, ['paused', 'paused'])
  await win.screenshot({ path: `${root}/stale-after-pause.png`, animations: 'disabled' })
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
