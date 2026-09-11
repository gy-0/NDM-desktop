// Renderer-only regression QA: real built React UI, isolated mock preload/engine.
// Never connects to a running NDM host, reads user downloads, or changes real files.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

const results = []
const mutationOps = ['pause', 'resume', 'remove', 'removeMany', 'restart', 'restartMany', 'pauseAll', 'resumeAll']

const output = resolve(process.env.NDM_QA_OUTPUT ?? join(tmpdir(), 'ndm-inspector-session-qa'))
const root = resolve('out/renderer')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return }
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(data)
  } catch { res.writeHead(404).end() }
})
await mkdir(output, { recursive: true })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}),
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu']
})
const errors = []
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
page.on('pageerror', (error) => errors.push(error.message))

await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window)
  window.__rafCount = 0
  window.requestAnimationFrame = (callback) => raf((time) => { window.__rafCount++; callback(time) })
  localStorage.setItem('ndm.onboarded', '1')
  const base = { folderPath: '/qa/Downloads', fileSize: 80 * 1024 ** 2, completedBytes: 20 * 1024 ** 2, bytesPerSecond: 0, connections: 8, segments: [], activityAt: Date.UTC(2026, 8, 7, 8) }
  const task = (id, filename, status, category, extra = {}) => ({ ...base, id, filename, title: filename, status, category, url: `https://example.com/${filename}`, source: 'example.com', ...extra })
  const initial = [
    task(101, 'Blender-4.3-macOS.dmg', 'downloading', 'application', { bytesPerSecond: 14.2 * 1024 ** 2, fileSize: 420 * 1024 ** 2, completedBytes: 238 * 1024 ** 2, activityAt: Date.UTC(2026, 8, 7, 9) }),
    task(102, 'Design systems handbook.pdf', 'paused', 'document'),
    task(103, 'Motion design masterclass.mp4', 'error', 'video', { errorText: '磁盘空间不足' }),
    task(104, 'Interface essentials.zip', 'complete', 'compressed', { completedBytes: base.fileSize }),
    task(105, 'Focus session.flac', 'waiting', 'audio'),
    task(106, 'Workspace illustration.png', 'paused', 'image'),
    task(107, '项目交付说明.md', 'complete', 'document', { completedBytes: base.fileSize }),
    task(108, 'Creative workflow.mp4', 'downloading', 'video', { bytesPerSecond: 3.8 * 1024 ** 2 })
  ]
  let tasks = structuredClone(initial)
  const events = new Set()
  const menus = new Set()
  const calls = []
  let pending = null
  const snapshot = () => events.forEach((cb) => cb({ op: 'snapshot', tasks: structuredClone(tasks) }))
  window.__qa = {
    relayBridge: { available: true, connectedClients: 0 },
    calls,
    reset: () => { tasks = structuredClone(initial); calls.length = 0; snapshot() },
    snapshot: (next) => { tasks = structuredClone(next); snapshot() },
    tasks: () => structuredClone(tasks),
    update: (id, patch) => { tasks = tasks.map((t) => t.id === id ? { ...t, ...patch } : t); snapshot() },
    menu: (action) => menus.forEach((cb) => cb(action)),
    delay: 0,
    fail: null,
    release: () => { pending?.(); pending = null }
  }
  window.ndm = {
    platform: new URLSearchParams(location.search).get('qaPlatform') || 'darwin', version: 'QA', build: 'isolated-renderer',
    status: async () => 'live', getEngineError: async () => null,
    onEvent: (cb) => { events.add(cb); return () => events.delete(cb) },
    onStatus: () => () => {},
    onMenuAction: (cb) => { menus.add(cb); return () => menus.delete(cb) },
    setWindowTheme: () => {}, notifySnapshot: () => {},
    readClipboardSnapshot: async () => ({ text: '', changeCount: 0 }),
    readClipboard: async () => '', writeClipboard: async (text) => { calls.push({ op: 'copy', text }); if (window.__qa.fail === 'copy') throw new Error('Clipboard denied') },
    loadFileThumbnail: async () => null, loadThumbnail: async () => null,
    extensionPath: async () => '/qa/NDMRelay',
    installDiskImage: async (path) => { calls.push({ op: 'installDiskImage', path }); return '' },
    openPath: async (path) => { calls.push({ op: 'openPath', path }); return '' },
    revealFile: async (path) => { calls.push({ op: 'revealFile', path }); return '' },
    quickLook: async (path) => { calls.push({ op: 'quickLook', path }); return true },
    request: async (op, extra = {}) => {
      if (op === 'getBridgeStatus') {
        if (window.__qa.fail === op) throw new Error('Bridge unavailable')
        return { bridge: window.__qa.relayBridge }
      }
      if (op === 'list') {
        if (new URLSearchParams(location.search).has('qaPendingLibrary')) await new Promise(resolve => setTimeout(resolve, 800))
        return { tasks: new URLSearchParams(location.search).has('qaPendingLibrary') ? [] : structuredClone(tasks) }
      }
      if (op === 'getSettings') return { settings: { downloadDirectory: '/qa/Downloads', maxConnections: 8, bandwidthLimitBytesPerSecond: 0, useCategoryFolders: false, downloadAllAtOnce: false, smartConnections: true, bridgePort: 9999 } }
      if (op === 'completionStack') return { artifacts: [] }
      if (op === 'fileArtwork') return { artwork: null }
      calls.push({ op, ...extra })
      if (window.__qa.delay && ['pause', 'resume', 'remove', 'removeMany'].includes(op)) await new Promise((done) => { pending = done })
      if (window.__qa.fail === op) throw new Error('QA injected failure')
      if (op === 'pause' || op === 'resume') {
        tasks = tasks.map((t) => t.id === extra.taskID ? { ...t, status: op === 'pause' ? 'paused' : 'downloading' } : t)
        snapshot()
      }
      if (op === 'remove') {
        tasks = tasks.filter((t) => t.id !== extra.taskID)
        snapshot()
      }
      if (op === 'removeMany') {
        tasks = tasks.filter((t) => !extra.taskIDs.includes(t.id))
        snapshot()
        return { ok: true, removed: extra.taskIDs.length }
      }
      return { ok: true }
    }
  }
})

// Each scenario drives the built Inspector and its real store commands. The
// preload delays acknowledgements so task switches race with actual promises.
async function reset() {
  await page.goto(url)
  await page.locator('[data-task-select="102"]').waitFor()
  await page.evaluate(() => {
    const base = window.__qa.tasks().find(task => task.id === 102)
    window.__qa.snapshot([102, 103].map(id => ({ ...base, id, status: 'error', filename: `Task-${id}.pdf`, title: `Task-${id}.pdf`, url: `https://example.com/${id}.pdf`, errorText: 'expired', diagnostic: { title: '链接已过期', message: '更新下载链接后继续', primaryAction: 'renew' } })))
    window.__deferred = []
    const request = window.ndm.request
    window.ndm.request = async (op, extra) => {
      if (op !== 'renew' && op !== 'remove') return request(op, extra)
      window.__qa.calls.push({ op, ...extra })
      return new Promise((resolve, reject) => window.__deferred.push({ op, id: extra.taskID, resolve, reject, extra }))
    }
    window.__ack = (index, failed = false) => {
      const pending = window.__deferred[index]
      if (failed) return pending.reject(new Error('Injected old-task failure'))
      const task = window.__qa.tasks().find(task => task.id === pending.id)
      pending.resolve(pending.op === 'renew' ? { task: { ...task, url: pending.extra.url } } : { ok: true })
    }
  })
}
const inspector = () => page.locator('#task-inspector')
async function select(id) { await page.locator(`[data-task-select="${id}"]`).click(); await inspector().getByRole('heading', { name: `Task-${id}.pdf`, exact: true }).waitFor() }
const renew = () => inspector().getByRole('textbox', { name: '新的下载链接' })
async function openRenew() { await inspector().getByRole('button', { name: '更新下载链接…', exact: true }).click(); await renew().waitFor() }
async function check(name, fn) { await reset(); await fn(); results.push(name); console.log(`PASS ${name}`) }
try {
  await check('switching tasks clears renewal input and destructive confirmation', async () => {
    await select(102); await openRenew(); await renew().fill('https://example.com/new-A.pdf')
    await select(103)
    assert.equal(await renew().count(), 0, 'Task B must not inherit the open renewal form from A')
    await openRenew()
    assert.equal(await renew().inputValue(), 'https://example.com/103.pdf')
    await inspector().getByRole('button', { name: '删除', exact: true }).click()
    await select(102)
    assert.equal(await inspector().getByRole('dialog').count(), 0, 'Task A must not inherit confirmation intended for B')
  })
  await check('late delete acknowledgement cannot close another task Inspector', async () => {
    await select(102)
    await inspector().getByRole('button', { name: '删除', exact: true }).click()
    await inspector().getByRole('button', { name: '仅从列表移除', exact: true }).click()
    await select(103)
    await page.evaluate(() => window.__ack(0))
    await page.waitForTimeout(100)
    assert.equal(await inspector().getByRole('heading', { name: 'Task-103.pdf', exact: true }).count(), 1)
    assert.deepEqual(await page.evaluate(() => window.__qa.calls.filter(c => c.op === 'remove').map(c => c.taskID)), [102])
  })
  await check('late renewal acknowledgement cannot close or overwrite another form', async () => {
    await select(102); await openRenew(); await renew().fill('https://example.com/new-A.pdf')
    await inspector().getByRole('button', { name: '更新并继续', exact: true }).click()
    assert.equal(await inspector().getByRole('button', { name: '更新并继续', exact: true }).isDisabled(), true)
    await select(103); await openRenew(); await renew().fill('https://example.com/new-B.pdf')
    await page.evaluate(() => window.__ack(0))
    await page.waitForTimeout(100)
    assert.equal(await renew().inputValue(), 'https://example.com/new-B.pdf')
    await inspector().getByRole('button', { name: '更新并继续', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__qa.calls.filter(c => c.op === 'renew').map(c => [c.taskID, c.url])), [[102, 'https://example.com/new-A.pdf'], [103, 'https://example.com/new-B.pdf']])
  })
  await check('late renewal failure cannot leak an error into another task', async () => {
    await select(102); await openRenew(); await renew().fill('https://example.com/new-A.pdf')
    await inspector().getByRole('button', { name: '更新并继续', exact: true }).click()
    await select(103); await openRenew(); await renew().fill('https://example.com/new-B.pdf')
    await page.evaluate(() => window.__ack(0, true))
    await page.waitForTimeout(100)
    assert.equal(await renew().inputValue(), 'https://example.com/new-B.pdf')
    assert.equal(await inspector().getByText('Injected old-task failure', { exact: true }).count(), 0)
    assert.equal(await inspector().getByRole('button', { name: '更新并继续', exact: true }).isEnabled(), true)
  })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: results.length, rendererErrors: errors }))
} finally {
  await page.screenshot({ path: join(output, 'final.png') })
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, rendererErrors: errors }))
  await browser.close(); server.closeAllConnections?.(); await new Promise(done => server.close(done))
}
