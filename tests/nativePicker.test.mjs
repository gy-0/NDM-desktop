import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNativePicker } from '../src/main/nativePicker.ts'

const owner = name => ({ name, destroyed: false, isDestroyed() { return this.destroyed } })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const openCancelled = () => ({ canceled: true, filePaths: [] })
const saveCancelled = () => ({ canceled: true, filePath: '' })

async function toolsFixture(t, dialogs, request = async () => ({ ok: true, settings: { maxConnections: 32 } })) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-picker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // Exercise the real tool services without loading Electron or showing a UI.
  // Keep esbuild external to the repository's own bundling test runner.
  const { build } = createRequire(resolve('package.json'))('esbuild')
  const bundle = await build({
    entryPoints: [resolve('src/main/downloadTools.ts')], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'isolated-electron-dialog-fixture', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'picker-fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'picker-fixture' }, () => ({ contents: `
        export const app = { getPath: () => ${JSON.stringify(root)}, getVersion: () => '2026.9.15', quit: () => { throw new Error('Unexpected quit') } };
        export const dialog = { showOpenDialog: () => { throw new Error('Uninjected open dialog') }, showSaveDialog: () => { throw new Error('Uninjected save dialog') } };
        export const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test' };
      ` }))
    } }]
  })
  const modulePath = join(root, 'downloadTools.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const { createDownloadTools } = await import(pathToFileURL(modulePath).href)
  const previousSupport = process.env.NDM_SUPPORT_DIR
  let tools
  try {
    process.env.NDM_SUPPORT_DIR = root
    tools = createDownloadTools(request, async () => ({ ok: true }), dialogs)
  } finally {
    if (previousSupport === undefined) delete process.env.NDM_SUPPORT_DIR
    else process.env.NDM_SUPPORT_DIR = previousSupport
  }
  t.after(() => tools.dispose())
  return { tools, root }
}

test('all five download-tool pickers attach to the requesting owner and preserve cancellation', async t => {
  const calls = [], window = owner('main')
  const { tools } = await toolsFixture(t, {
    showOpenDialog: async (parent, options) => { calls.push({ parent, options, kind: 'open' }); return openCancelled() },
    showSaveDialog: async (parent, options) => { calls.push({ parent, options, kind: 'save' }); return saveCancelled() }
  })
  for (const [op, expected] of [
    ['auxiliaryChooseTorrent', { ok: true, torrent: null }],
    ['directoryRulesChooseDirectory', { ok: true, directory: null }],
    ['settingsBackupExport', { ok: true, cancelled: true }],
    ['settingsBackupPreview', { ok: true, cancelled: true }],
    ['downloadImportPreview', { ok: true, cancelled: true }]
  ]) assert.deepEqual(await tools.request(op, op === 'downloadImportPreview' ? { source: 'file' } : {}, window), expected)
  assert.deepEqual(calls.map(call => call.options.title), ['选择种子文件', '选择规则的下载目录', '导出下载设置', '导入下载设置', '导入下载任务'])
  assert.ok(calls.every(call => call.parent === window))
  assert.deepEqual(calls.map(call => call.kind), ['open', 'open', 'save', 'open', 'open'])
  assert.deepEqual(calls[0].options.filters, [{ name: 'BitTorrent 种子', extensions: ['torrent'] }])
  assert.deepEqual(calls[1].options.properties, ['openDirectory', 'createDirectory'])
})

test('queued backup requests and an overlapping torrent picker retain separate owners across awaits', { timeout: 5000 }, async t => {
  const first = owner('first'), second = owner('second'), third = owner('third')
  const settingsStarted = deferred(), settingsReady = deferred(), calls = []
  const { tools } = await toolsFixture(t, {
    showOpenDialog: async (parent, options) => { calls.push([parent, options.title]); return openCancelled() },
    showSaveDialog: async (parent, options) => { calls.push([parent, options.title]); return saveCancelled() }
  }, async op => {
    assert.equal(op, 'getSettings'); settingsStarted.resolve(); await settingsReady.promise
    return { ok: true, settings: { maxConnections: 32 } }
  })
  const exportRequest = tools.request('settingsBackupExport', {}, first)
  await settingsStarted.promise
  const importRequest = tools.request('settingsBackupPreview', {}, second)
  await tools.request('auxiliaryChooseTorrent', {}, third)
  settingsReady.resolve()
  await Promise.all([exportRequest, importRequest])
  assert.deepEqual(calls, [[third, '选择种子文件'], [first, '导出下载设置'], [second, '导入下载设置']])
})

test('a cancelled or failed torrent picker can be opened again and captures the newly selected file', async t => {
  const window = owner('main'); let attempt = 0, path
  const { tools, root } = await toolsFixture(t, {
    showOpenDialog: async parent => {
      assert.equal(parent, window); attempt++
      if (attempt === 1) return openCancelled()
      if (attempt === 2) throw new Error('Fixture native picker error')
      return { canceled: false, filePaths: [path] }
    },
    showSaveDialog: async () => saveCancelled()
  })
  path = join(root, 'fixture.torrent')
  await writeFile(path, 'd4:infod4:name7:fixtureee')
  assert.deepEqual(await tools.request('auxiliaryChooseTorrent', {}, window), { ok: true, torrent: null })
  assert.equal((await tools.request('auxiliaryChooseTorrent', {}, window)).ok, false)
  const selected = await tools.request('auxiliaryChooseTorrent', {}, window)
  assert.equal(selected.ok, true)
  assert.equal(selected.torrent.filename, 'fixture.torrent')
  assert.match(selected.torrent.token, /^[a-f\d]{32}$/)
  assert.equal(attempt, 3)
})

test('missing or destroyed owners cancel without opening an independent dialog', async () => {
  const picker = createNativePicker({
    showOpenDialog: async () => assert.fail('Must not open without an owner'),
    showSaveDialog: async () => assert.fail('Must not save without an owner')
  })
  const destroyed = owner('closed'); destroyed.destroyed = true
  for (const window of [null, undefined, destroyed]) {
    assert.deepEqual(await picker.run(window, () => picker.open({})), openCancelled())
    assert.deepEqual(await picker.run(window, () => picker.save({})), saveCancelled())
  }
  assert.deepEqual(await picker.open({}), openCancelled())
})

test('an owner destroyed before a queued picker is reached never creates a dialog', { timeout: 5000 }, async t => {
  const window = owner('closing'), started = deferred(), ready = deferred()
  const { tools } = await toolsFixture(t, {
    showOpenDialog: async () => assert.fail('Unexpected open'),
    showSaveDialog: async () => assert.fail('Unexpected save')
  }, async () => {
    started.resolve(); await ready.promise
    return { ok: true, settings: { maxConnections: 32 } }
  })
  const request = tools.request('settingsBackupExport', {}, window)
  await started.promise; window.destroyed = true; ready.resolve()
  assert.deepEqual(await request, { ok: true, cancelled: true })
})

test('a picker result is discarded if its owner closed while the native dialog was open', async () => {
  const window = owner('closing'), result = deferred()
  const picker = createNativePicker({
    showOpenDialog: async parent => { assert.equal(parent, window); return result.promise },
    showSaveDialog: async () => saveCancelled()
  })
  const pending = picker.run(window, () => picker.open({}))
  window.destroyed = true
  result.resolve({ canceled: false, filePaths: ['/unused/selected.torrent'] })
  assert.deepEqual(await pending, openCancelled())
})
