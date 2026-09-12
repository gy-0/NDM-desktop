// Real Electron main/preload/renderer with a private TCP fixture engine.
// Saves settings and draft changes only under a newly-created /tmp directory;
// creation receipts are synthetic and never download a file or launch NDMHost.
// Run --before against the unchanged build, then run after the unified build.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const before = process.argv.includes('--before')
const phase = before ? 'before' : 'after'
const repository = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync('/tmp/ndm-entry-simplification-')
const output = resolve(process.env.NDM_QA_ENTRY_OUTPUT || `${repository}/docs/design/assets/2026-09-12-entry-simplification`, phase)
mkdirSync(`${root}/files`, { recursive: true })
mkdirSync(output, { recursive: true })
const buildFingerprint = Object.fromEntries(['out/main/index.js', 'out/preload/index.mjs', ...readdirSync(`${repository}/out/renderer/assets`).filter(name => /\.(css|js)$/.test(name)).map(name => `out/renderer/assets/${name}`)].map(path => [path, createHash('sha256').update(readFileSync(`${repository}/${path}`)).digest('hex')]))
const defaults = { downloadDirectory: `${root}/files`, maxConnections: 32, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, smartConnections: false, downloadAllAtOnce: true, useCategoryFolders: false, installerSourceDisposition: 'ask', bridgePort: 0 }
let settings = { ...defaults }
let failConnections = false
const tasks = [], requests = [], receipts = new Map(), sockets = new Set(), evidence = [], checks = [], errors = []
const send = (socket, reply) => { if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n') }
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', error => errors.push(error.message))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      const { id, op, ...args } = request
      requests.push({ op, ...args })
      const reply = { id, ok: true }
      if (op === 'list') reply.tasks = tasks
      if (op === 'getSettings') reply.settings = settings
      if (op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, relayClients: [] }
      if (op === 'checkStorage') reply.level = 'unknown'
      if (op === 'updateSettings') {
        if (failConnections && 'maxConnections' in args) {
          failConnections = false
          send(socket, { id, ok: false, error: '合成测试：设置暂未保存' })
          continue
        }
        settings = { ...settings, ...args }
        reply.settings = settings
      }
      if (op === 'getCreationReceipt') {
        const task = receipts.get(args.creationKey)
        reply.receipt = task ? { taskID: task.id, taskExists: true } : null
        if (task) reply.task = task
      }
      if (op === 'add') {
        assert.ok(args.url.startsWith('https://example.com/entry-fixture/'), 'Only synthetic URLs are permitted')
        const existing = args.creationKey && receipts.get(args.creationKey)
        const task = existing || { id: 700 + tasks.length, title: '', filename: new URL(args.url).pathname.split('/').at(-1), url: args.url, source: 'example.com', folderPath: args.folderPath || settings.downloadDirectory, category: 'document', status: 'waiting', fileSize: 8192, completedBytes: 0, bytesPerSecond: 0, connections: args.connections || settings.maxConnections, segments: [], activityAt: Date.now() }
        if (!existing) tasks.push(task)
        if (args.creationKey) receipts.set(args.creationKey, task)
        reply.task = task
      }
      send(socket, reply)
      if (op === 'add') for (const connected of sockets) send(connected, { op: 'snapshot', tasks })
    }
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
let app, win
const settingsWrites = () => requests.filter(request => request.op === 'updateSettings')
const creations = () => requests.filter(request => request.op === 'add')
try {
  const env = { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${root}/electron`], cwd: repository, env })
  win = await app.firstWindow()
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1220, 820)
    for (const [channel, handler] of Object.entries({
      'system:read-clipboard': () => '',
      'system:clipboard-snapshot': () => ({ text: '', changeCount: 0, selfWritten: false }),
      'system:classify-url': () => ({ kind: 'binary', contentType: 'application/octet-stream' })
    })) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => handler(...args))
    }
  })
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  const capture = async name => {
    await win.mouse.move(6, 6)
    await win.waitForTimeout(160)
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(`${output}/${name}.png`, Buffer.from(png, 'base64'))
    evidence.push({ name, ...await win.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth })) })
  }
  const openSettings = async () => {
    await win.locator('[data-settings-trigger]').click()
    await win.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '下载', exact: true }).click()
    await win.getByRole('switch', { name: '同时下载多个任务', exact: true }).waitFor()
  }
  const performance = win.locator('section[data-settings-page="downloads"]').filter({ has: win.getByText('下载性能', { exact: true }) })
  const choices = performance.getByRole('group', { name: '单任务最大连接数', exact: true })
  const advanced = performance.locator('details')
  await openSettings()
  await capture('settings-downloads-top-1220')
  await performance.scrollIntoViewIfNeeded()
  if (before) {
    await performance.getByRole('switch', { name: '智能连接调节', exact: true }).waitFor()
    assert.equal(await choices.isVisible(), true, 'before captures the original visible connection choices')
  } else {
    assert.equal(await win.getByRole('switch', { name: '智能连接调节', exact: true }).count(), 0)
    assert.equal(await advanced.getAttribute('open'), null)
    assert.equal(await choices.isVisible(), false)
  }
  assert.equal(settingsWrites().length, 0, 'Opening settings must not rewrite saved values')
  assert.deepEqual(settings, defaults)
  await capture('settings-performance-1220')
  if (!before) {
    await advanced.locator('summary').click()
    assert.equal(await choices.getByRole('button', { name: '32', exact: true }).getAttribute('aria-pressed'), 'true')
    await capture('settings-advanced-1220')
    failConnections = true
    await choices.getByRole('button', { name: '16', exact: true }).click()
    await win.locator('#connection-setting-status').getByText('未能保存连接数。请重试。', { exact: true }).waitFor()
    assert.equal(settings.maxConnections, 32)
    assert.equal(await choices.getByRole('button', { name: '32', exact: true }).getAttribute('aria-pressed'), 'true')
    await capture('settings-save-failure-1220')
    await choices.getByRole('button', { name: '16', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('[aria-label="单任务最大连接数"] [aria-pressed="true"]')?.textContent === '16')
    assert.equal(settings.smartConnections, false)
    assert.equal(settings.bandwidthLimitBytesPerSecond, 0)
    await win.getByRole('button', { name: '返回应用', exact: true }).click()
    settings = { ...defaults, maxConnections: 8, smartConnections: true, bandwidthLimitBytesPerSecond: 5242880 }
    const writesBeforeLegacyOpen = settingsWrites().length
    await openSettings()
    if (!await choices.isVisible()) await advanced.locator('summary').click()
    await choices.getByRole('button', { name: '8', exact: true }).waitFor()
    await win.waitForFunction(() => document.querySelector('[aria-label="单任务最大连接数"] [aria-pressed="true"]')?.textContent === '8')
    assert.equal(settingsWrites().length, writesBeforeLegacyOpen)
    await choices.getByRole('button', { name: '16', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('[aria-label="单任务最大连接数"] [aria-pressed="true"]')?.textContent === '16')
    assert.equal(settings.smartConnections, true, 'Changing connection count preserves the existing smart policy')
    assert.equal(settings.bandwidthLimitBytesPerSecond, 5242880, 'Changing connection count preserves saved bandwidth')
    checks.push('normal settings hide smart tuning and connection count; advanced changes acknowledge success/failure without migrating existing policies')
  }
  await win.getByRole('button', { name: '返回应用', exact: true }).click()
  settings = { ...defaults }

  const dialog = win.getByRole('dialog', { name: '添加下载', exact: true })
  const input = dialog.getByRole('textbox', { name: '下载链接', exact: true })
  const openComposer = async () => { await win.keyboard.press('Meta+n'); await dialog.waitFor(); await input.waitFor({ state: 'visible' }); await win.waitForFunction(() => !document.querySelector('[aria-label="下载链接"]')?.disabled) }
  const closeComposer = async () => { await dialog.getByRole('button', { name: /^(关闭|取消)$/ }).click(); await dialog.waitFor({ state: 'hidden' }) }
  const paste = text => input.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
  await openComposer()
  assert.equal(await dialog.getByRole('region', { name: '待下载清单' }).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '开始下载', exact: true }).isDisabled(), true)
  if (before) assert.match(await dialog.locator('#composer-submit-hint').innerText(), /批量粘贴/)
  else assert.doesNotMatch(await dialog.locator('#composer-submit-hint').innerText(), /批量/)
  await capture('composer-idle-1220')
  await paste('https://example.com/entry-fixture/manual.pdf')
  assert.equal(await dialog.getByRole('region', { name: '待下载清单' }).count(), 0)
  assert.equal(creations().length, 0, 'Single-link paste does not create a task')
  await capture('composer-single-link-1220')
  await input.fill('not a download link')
  await dialog.getByRole('button', { name: '开始下载', exact: true }).click()
  await dialog.getByText('请输入有效的下载链接。', { exact: true }).waitFor()
  assert.equal(creations().length, 0)
  await closeComposer()
  await openComposer()
  const links = ['https://example.com/entry-fixture/alpha.zip', 'https://example.com/entry-fixture/beta.pdf']
  await paste([...links, links[0]].join('\n'))
  await dialog.getByRole('region', { name: '待下载清单' }).waitFor()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  assert.equal(creations().length, 0, 'Pasting multiple links only prepares the review')
  await capture('composer-batch-review-1220')
  await closeComposer()
  const saved = await win.evaluate(() => window.ndm.request('composerDraftLoad'))
  assert.equal(saved.ok, true)
  assert.equal(saved.draft.items.length, 2)
  await openComposer()
  await dialog.getByRole('region', { name: '待下载清单' }).waitFor()
  assert.equal(await dialog.locator('[data-batch-link]').count(), 2)
  if (!before) {
    await dialog.getByRole('button', { name: '下载 2 项', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(creations().length, 2)
    assert.ok(creations().every(request => request.connections === 32 && request.folderPath === defaults.downloadDirectory && request.creationKey))
    assert.equal(receipts.size, 2)
    checks.push('single links remain direct, invalid links do not submit, multi-link paste deduplicates without creating tasks, persisted drafts resume and explicit confirmation produces per-item receipts')
  } else await closeComposer()
  assert.deepEqual(errors, [])
  writeFileSync(`${output}/result.json`, JSON.stringify({ phase, passed: true, root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), buildFingerprint, fixtureOnly: true, runtime: 'real Electron main/preload/renderer; private TCP engine, real isolated draft persistence, synthetic creation receipts', checks, evidence, requests, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, phase, output, checks }))
} catch (error) {
  await win?.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  writeFileSync(`${output}/failure.json`, JSON.stringify({ error: String(error), requests, errors }, null, 2))
  throw error
} finally {
  await app?.close().catch(() => {})
  sockets.forEach(socket => socket.destroy())
  await new Promise(done => server.close(done))
}
