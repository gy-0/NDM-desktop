// Actual Electron renderer and encrypted draft controller; media replies are
// controlled fixtures. No browser credentials or real downloads are accessed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const options = qaLaunchOptions('composer-relay-session')
const root = options.env.NDM_SUPPORT_DIR.replace(/\/engine$/, '')
const url = 'https://www.youtube.com/watch?v=relay-fixture'
const ids = Object.fromEntries(['a', 'b', 'c', 'denied', 'refreshable', 'expired', 'draft'].map(key => [key, randomUUID()]))
const checks = [], errors = []
let app, win, input
async function launch() {
  app = await electron.launch(options)
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.setDefaultTimeout(15000)
  win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain }, ids) => {
    const q = globalThis.relayComposerQA = { calls: [], pending: null, receipts: {}, ids }
    const original = ipcMain._invokeHandlers.get('engine:request')
    if (!original) throw new Error('Missing actual private draft controller')
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (event, op, extra) => {
      if (['composerDraftLoad', 'composerDraftSave', 'composerDraftDiscard', 'composerDraftFlushResult'].includes(op)) return original(event, op, extra)
      q.calls.push({ op, extra })
      const task = { id: 938001, url: extra?.url, filename: 'Relay fixture.mp4', status: 'paused', fileSize: 10000, completedBytes: 0, segments: [] }
      if (op === 'probeMedia') {
        const reply = { ok: true, title: extra.browserSessionID || extra.cookieBrowser || 'Anonymous fixture', formats: [{ id: '720p', label: '720p', height: 720, containerHint: 'MP4', approximateBytes: 10000, componentBytes: 10000, compactApproximateBytes: 10000, compactComponentBytes: 10000 }], subtitles: [] }
        if (extra.browserSessionID === ids.denied) return { ok: false, errorKind: 'browserSessionRequired' }
        if (extra.browserSessionID === ids.refreshable && q.calls.filter(call => call.op === 'probeMedia' && call.extra.browserSessionID === ids.refreshable).length === 1) return { ok: false, errorKind: 'browserSessionRequired' }
        if (extra.browserSessionID === ids.expired) return { ok: false, errorKind: 'browserDataUnavailable' }
        if (extra.browserSessionID === ids.b) return new Promise(resolve => { q.pending = () => { resolve(reply); q.pending = null } })
        return reply
      }
      if (op === 'getCreationReceipt') return { ok: true, ...(q.receipts[extra.creationKey] || { pending: false, receipt: null }) }
      if (op === 'addMedia') return { ok: true, task }
      return { ok: true, tasks: [] }
    })
    for (const [channel, handler] of [
      ['system:classify-url', () => { q.calls.push({ op: 'classify' }); return { kind: 'html' } }],
      ['system:read-clipboard', () => ''],
      ['system:clipboard-snapshot', () => ({ text: '', changeCount: 0, selfWritten: false })],
      ['system:write-clipboard', () => undefined]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  }, ids)
  await completeOnboarding(win)
  input = win.getByRole('textbox', { name: '下载链接', exact: true })
}
const calls = () => app.evaluate(() => globalThis.relayComposerQA.calls)
const probes = async () => (await calls()).filter(call => call.op === 'probeMedia')
async function send(id, target = url) {
  await app.evaluate(({ BrowserWindow }, { id, target }) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'openMediaComposer', url: target, browserSessionID: id, browserSessionBrowser: 'chrome' }), { id, target })
  await input.waitFor()
}
async function close() {
  await win.getByRole('button', { name: '取消', exact: true }).click()
  await input.waitFor({ state: 'hidden' })
}
async function paste(text) {
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}
async function awaitProbe(id) {
  await win.waitForFunction(id => {
    return document.querySelector('h3')?.textContent === id
  }, id)
}
try {
  await launch()
  await send(ids.a); await awaitProbe(ids.a)
  const firstProbes = await probes()
  assert.ok(firstProbes.length, JSON.stringify({ calls: await calls(), headings: await win.locator('h3').allTextContents() }))
  assert.equal(firstProbes.at(-1).extra.browserSessionBrowser, 'chrome')
  assert.equal((await calls()).filter(call => call.op === 'classify').length, 0)
  await send(ids.b)
  for (let attempt = 0; attempt < 100 && !await app.evaluate(() => Boolean(globalThis.relayComposerQA.pending)); attempt++) await win.waitForTimeout(30)
  assert.equal(await app.evaluate(() => Boolean(globalThis.relayComposerQA.pending)), true)
  await send(ids.c); await awaitProbe(ids.c)
  await app.evaluate(() => globalThis.relayComposerQA.pending())
  await win.waitForTimeout(150)
  await awaitProbe(ids.c)
  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await input.waitFor({ state: 'hidden' })
  const created = (await calls()).filter(call => call.op === 'addMedia').at(-1).extra
  assert.equal(created.browserSessionID, ids.c)
  assert.equal(created.cookieBrowser, 'chrome')
  checks.push('same URL handoff rebinds; late prior-profile response cannot replace current metadata or download source')

  await send(ids.a); await awaitProbe(ids.a)
  await input.fill(`${url}-edited`); await awaitProbe('Anonymous fixture')
  assert.equal((await probes()).at(-1).extra.browserSessionID, undefined)
  await close()
  await send(ids.a); await awaitProbe(ids.a)
  await paste(url); await awaitProbe('Anonymous fixture')
  assert.equal((await probes()).at(-1).extra.browserSessionID, undefined)
  await close()
  checks.push('manual URL edits and same-URL paste clear the former handoff identity')

  await send(ids.denied)
  const browser = win.getByRole('combobox', { name: '会话浏览器', exact: true })
  const refresh = win.getByRole('button', { name: '刷新浏览器会话', exact: true })
  await refresh.waitFor()
  assert.equal(await browser.inputValue(), 'chrome')
  await refresh.click()
  await win.getByText('请回到原浏览器确认视频可播放，再点击下载。', { exact: true }).waitFor()
  const sameProfile = (await probes()).filter(call => call.extra.browserSessionID === ids.denied)
  assert.equal(sameProfile.length, 2)
  assert.equal(sameProfile[1].extra.browserSessionBrowser, 'chrome')
  assert.equal(sameProfile[1].extra.cookieBrowser, undefined, 'Refreshing Chrome must not read its default profile')
  checks.push('Relay authorization retry keeps the original token and browser; a repeated failure points back to the original browser')
  await browser.selectOption('firefox')
  const count = (await probes()).length
  await win.waitForTimeout(300)
  assert.equal((await probes()).length, count, 'Selection alone must not read another browser')
  await win.getByRole('button', { name: '使用 Firefox 会话重试', exact: true }).click()
  await awaitProbe('firefox')
  assert.equal((await probes()).at(-1).extra.browserSessionID, undefined)
  await win.getByRole('button', { name: '开始下载', exact: true }).click(); await input.waitFor({ state: 'hidden' })
  const explicit = (await calls()).filter(call => call.op === 'addMedia').at(-1).extra
  assert.equal(explicit.browserSessionID, undefined)
  assert.equal(explicit.cookieBrowser, 'firefox')
  checks.push('explicit browser retry replaces the Relay source only after the user invokes retry')

  await send(ids.refreshable)
  await refresh.click()
  await awaitProbe(ids.refreshable)
  await win.getByRole('button', { name: '开始下载', exact: true }).click(); await input.waitFor({ state: 'hidden' })
  const renewed = (await calls()).filter(call => call.op === 'addMedia').at(-1).extra
  assert.equal(renewed.browserSessionID, ids.refreshable)
  assert.equal(renewed.browserSessionBrowser, 'chrome')
  assert.equal(renewed.cookieBrowser, 'chrome')
  checks.push('successful original-profile refresh preserves its token through download creation')

  await send(ids.expired)
  await win.getByText('浏览器连接已断开。请回到原浏览器重新点击下载。', { exact: true }).waitFor()
  assert.equal(await browser.count(), 0)
  await refresh.click()
  await win.getByText('浏览器连接已断开。请回到原浏览器重新点击下载。', { exact: true }).waitFor()
  assert.equal((await probes()).at(-1).extra.browserSessionID, ids.expired)
  await close()
  checks.push('unreachable Relay is described as disconnected, and retry preserves its originating profile')

  const acceptedKey = randomUUID(), pendingKey = randomUUID()
  const item = (key, status, target) => ({ id: randomUUID(), url: target, status, operationID: key, request: { op: 'addMedia', options: { url: target, creationKey: key, formatID: '720p', container: 'compatibleMP4', collectionScope: 'current', browserSessionID: ids.draft, cookieBrowser: 'chrome' } } })
  const draft = { version: 1, id: randomUUID(), input: '', destination: { mode: 'inherit' }, connections: { mode: 'inherit' }, items: [item(acceptedKey, 'unconfirmed', `${url}-accepted`), item(pendingKey, 'failed', `${url}-pending`)] }
  const saved = await win.evaluate(async draft => {
    const current = await window.ndm.request('composerDraftLoad')
    return window.ndm.request('composerDraftSave', { expectedRevision: current.revision, draft })
  }, draft)
  assert.equal(saved.ok, true)
  await app.close(); app = null
  await launch()
  await app.evaluate((_e, acceptedKey) => { globalThis.relayComposerQA.receipts[acceptedKey] = { pending: false, receipt: { taskID: 938009, taskExists: true }, task: { id: 938009, filename: 'Already accepted.mp4' } } }, acceptedKey)
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  const loaded = await win.evaluate(() => window.ndm.request('composerDraftLoad'))
  assert.equal(loaded.draft.items[1].request.options.browserSessionID, ids.draft)
  await win.getByRole('button', { name: '确认 1 项', exact: true }).click()
  await win.getByRole('button', { name: '重试 1 项', exact: true }).click()
  await input.waitFor({ state: 'hidden' })
  const replay = (await calls()).filter(call => ['getCreationReceipt', 'addMedia', 'probeMedia', 'classify', 'add'].includes(call.op))
  assert.deepEqual(replay.map(call => call.op), ['getCreationReceipt', 'getCreationReceipt', 'addMedia'])
  assert.equal(replay[0].extra.creationKey, acceptedKey)
  assert.equal(replay[1].extra.creationKey, pendingKey)
  assert.equal(replay[2].extra.browserSessionID, ids.draft)
  assert.equal(replay[2].extra.cookieBrowser, 'chrome')
  assert.equal(replay[2].extra.creationKey, pendingKey)
  checks.push('encrypted draft survives actual Electron restart; receipt is checked first; unaccepted replay preserves ID+browser without reclassification')
  assert.deepEqual(errors, [])
  writeFileSync(`${root}/result.json`, JSON.stringify({ passed: true, checks, errors, scope: 'real Electron renderer + encrypted durable draft; controlled media IPC replies, no credentials' }, null, 2))
  console.log(JSON.stringify({ passed: true, root, checks }))
} finally { if (app) await app.close() }
