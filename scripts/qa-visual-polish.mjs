// Isolated Electron renderer QA. No real main process, preload, engine, files or downloads.
// Build first: npm run build. Audio is disabled before renderer initialization and muted by Electron.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { _electron as electron } from 'playwright'

const root = resolve('out/renderer')
const platformQuery = process.argv.includes('--windows') ? '&platform=win32' : ''
const fixtureRoot = await mkdtemp('/tmp/ndm-visual-polish-')
const output = process.env.NDM_VISUAL_QA_OUTPUT || join(fixtureRoot, 'artifacts')
const testedBuild = {}
for (const file of ['index.html', ...(await readdir(join(root, 'assets'))).filter(file => /\.(css|js)$/.test(file)).map(file => 'assets/' + file)]) testedBuild[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
await mkdir(output, { recursive: true })
const fixture = () => {
  localStorage.setItem('ndm-sound', '0')
  localStorage.setItem('ndm.onboarded', '1')
  localStorage.setItem('ndm.library-layout', 'list')
  const MiB = 1024 ** 2
  const base = { connections: 8, segments: [], folderPath: '/qa/Downloads', source: 'downloads.example.test', bytesPerSecond: 0, activityAt: Date.UTC(2026, 9, 4, 8) }
  const task = (id, filename, status, category, extra = {}) => ({ ...base, id, filename, title: filename, url: `https://downloads.example.test/${id}`, status, category, fileSize: 400 * MiB, completedBytes: 140 * MiB, ...extra })
  const initial = [
    task(101, 'Blender-4.3-macOS.dmg', 'downloading', 'application', { bytesPerSecond: 12.4 * MiB, completedBytes: 240 * MiB }),
    task(102, 'Design systems handbook.pdf', 'paused', 'document', { fileSize: 18 * MiB, completedBytes: 8 * MiB }),
    task(103, 'Motion design masterclass.mp4', 'error', 'video', { errorText: '磁盘空间不足，请释放空间后继续下载。' }),
    task(104, 'Interface essentials.zip', 'complete', 'compressed', { completedBytes: 400 * MiB }),
    task(105, 'Focus session.flac', 'waiting', 'audio', { completedBytes: 0 }),
    task(106, 'Workspace illustration.png', 'paused', 'image'),
    task(107, '项目交付说明.md', 'complete', 'document', { fileSize: 64 * 1024, completedBytes: 64 * 1024 }),
    task(108, 'Creative workflow.mp4', 'downloading', 'video', { bytesPerSecond: 3.8 * MiB }),
    task(109, '来源服务器中断后保留的下载记录.zip', 'error', 'compressed', { errorText: '连接中断，请检查网络后重试。', completedBytes: 0 }),
    task(110, 'Unknown length stream.zip', 'paused', 'compressed', { fileSize: 0, completedBytes: 12 * MiB })
  ]
  let tasks = structuredClone(initial)
  const events = new Set(), menus = new Set(), chromes = new Set(), calls = []
  let draft = { revision: 0, draft: null }
  const publish = () => events.forEach(cb => cb({ op: 'snapshot', tasks: structuredClone(tasks) }))
  window.__qa = { calls, fail: null, draftFailure: false, zoom: 1, fullScreen: false, chrome: state => { window.__qa.fullScreen = state.fullScreen; chromes.forEach(cb => cb(state)) }, emit: message => events.forEach(cb => cb(message)), update: (id, patch) => { tasks = tasks.map(task => task.id === id ? { ...task, ...patch } : task); publish() }, reset: () => { tasks = structuredClone(initial); publish() }, replace: next => { tasks = structuredClone(next); publish() }, tasks: () => structuredClone(tasks) }
  window.ndm = {
    platform: new URLSearchParams(location.search).get('platform') || 'darwin', version: 'visual-QA', build: 'isolated',
    status: async () => 'live', getEngineError: async () => null,
    getWindowZoomFactor: () => window.__qa.zoom, getWindowChrome: async () => ({ fullScreen: window.__qa.fullScreen }), onWindowChromeChanged: cb => { chromes.add(cb); return () => chromes.delete(cb) },
    onEvent: cb => { events.add(cb); return () => events.delete(cb) }, onStatus: () => () => {}, onMenuAction: cb => { menus.add(cb); return () => menus.delete(cb) },
    readClipboardSnapshot: async () => ({ text: '', changeCount: 0 }), readClipboard: async () => '', writeClipboard: async () => {},
    setWindowTheme: () => {}, notifySnapshot: () => {}, loadFileThumbnail: async () => null, loadThumbnail: async () => null,
    openPath: async () => '', revealFile: async () => '', quickLook: async () => true, openExternal: async () => true,
    request: async (op, extra = {}) => {
      if (op === 'list') return { ok: true, tasks: structuredClone(tasks) }
      if (op === 'getSettings') return { settings: { downloadDirectory: '/qa/Downloads', maxConnections: 8, bandwidthLimitBytesPerSecond: 0, downloadAllAtOnce: false, smartConnections: true, bridgePort: 9999 } }
      if (op === 'getBridgeStatus') return { bridge: { available: true, connectedClients: 0 } }
      if (op === 'composerDraftLoad') return { ok: true, ...draft }
      if (op === 'composerDraftSave' || op === 'composerDraftDiscard') {
        calls.push({ op })
        if (window.__qa.draftFailure) return { ok: false, error: '系统安全存储暂不可用，清单尚未保存。' }
        draft = { revision: draft.revision + 1, draft: op === 'composerDraftSave' ? extra.draft : null }; return { ok: true, ...draft }
      }
      if (op === 'findDuplicate') return { ok: true, task: null }
      if (op === 'checkStorage') return { ok: true, level: 'comfortable', availableBytes: 100000 * MiB, peakBytes: 64 * MiB, projectedFreeBytes: 99000 * MiB }
      if (op === 'composerDraftFlushResult') return { ok: true }
      if (op === 'completionStack') return { artifacts: [] }
      if (op === 'fileArtwork') return { artwork: null }
      if (op === 'temporaryBandwidthStatus') return { status: 'inactive', limitBytesPerSecond: null, expiresAt: null }
      if (op === 'completionActionStatus') return { ok: true, state: { phase: 'off', trackedTaskIDs: [], remainingTaskCount: 0 } }
      calls.push({ op, ...extra })
      if (window.__qa.fail === op) throw new Error('合成测试：服务暂时不可用，请重试。')
      if (['pause', 'resume', 'restart'].includes(op)) { tasks = tasks.map(task => task.id === extra.taskID ? { ...task, status: op === 'pause' ? 'paused' : 'downloading', errorText: undefined, bytesPerSecond: op === 'pause' ? 0 : 2 * MiB } : task); publish() }
      return { ok: true }
    }
  }
  if (window.ndm.platform === 'win32') {
    // Preview-only native control silhouettes. Never shipped as app controls.
    let preview
    const paint = () => {
      if (!preview) return
      const zoom = window.__qa.zoom
      preview.style.width = `${138 / zoom}px`
      preview.style.height = `${52 / zoom}px`
      preview.style.display = window.__qa.fullScreen ? 'none' : 'flex'
      preview.querySelectorAll('svg').forEach(svg => { svg.style.width = `${12 / zoom}px`; svg.style.height = `${12 / zoom}px` })
    }
    document.addEventListener('DOMContentLoaded', () => {
      preview = document.createElement('div')
      preview.dataset.qaNativeControls = 'illustration'
      preview.setAttribute('aria-hidden', 'true')
      preview.style.cssText = 'position:fixed;right:0;top:0;z-index:10000;pointer-events:none;color:var(--fog);display:flex'
      preview.innerHTML = ['<path d="M1 6h10"/>', '<rect x="1.5" y="1.5" width="9" height="9"/>', '<path d="m1 1 10 10M11 1 1 11"/>'].map(shape => `<span style="display:grid;place-items:center;flex:1"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1">${shape}</svg></span>`).join('')
      document.body.append(preview)
      paint()
    })
    window.addEventListener('resize', paint)
    const chrome = window.__qa.chrome
    window.__qa.chrome = state => { chrome(state); paint() }
  }
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path))
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return }
    let data = await readFile(file)
    if (extname(file) === '.html') data = Buffer.from(data.toString().replace('<head>', `<head><script>(${fixture.toString()})()</script>`))
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(data)
  } catch { res.writeHead(404).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`
const main = join(fixtureRoot, 'silent-renderer.cjs')
await writeFile(main, `const { app, BrowserWindow, session } = require('electron');
app.commandLine.appendSwitch('mute-audio');
app.setPath('userData', ${JSON.stringify(join(fixtureRoot, 'profile'))});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(${JSON.stringify(url)}) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') }));
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.setAudioMuted(true);
  win.loadURL(${JSON.stringify(url)} + '/?theme=dawn${platformQuery}');
}); app.on('window-all-closed', () => app.quit());`)
let app
const errors = [], checks = [], geometries = []
const check = async (name, run) => { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  app = await electron.launch({ args: [main, '--mute-audio'], timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  page.setDefaultNavigationTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('[data-hero-state]').waitFor({ timeout: 15000 })
  const capture = async name => {
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(240)
    // Playwright's CSS-sized clip crops Electron screenshots at renderer zoom.
    // Capture the actual window surface so the evidence matches what is drawn.
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  }
  await capture('01-dawn-workspace')
  if (platformQuery) {
    const toolbarPng = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return (await win.capturePage({ x: 0, y: 0, width: win.getContentSize()[0], height: 100 })).toPNG().toString('base64')
    })
    await writeFile(join(output, 'windows-toolbar-preview.png'), Buffer.from(toolbarPng, 'base64'))
  }
  if (!process.argv.includes('--capture-only') && !process.argv.includes('--chrome-only')) {
    await check('renderer audio remains disabled and Electron output muted', async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem('ndm-sound')), '0')
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isAudioMuted()), true)
    })
    const row = id => page.locator(`[data-task-select="${id}"]`)
    await check('failed rows show their actual reason and received progress without hover', async () => {
      const failed = row(103).locator('..')
      assert.match(await failed.locator('[data-task-recovery]').innerText(), /磁盘空间不足/)
      assert.equal(await failed.getByRole('progressbar').getAttribute('aria-valuenow'), '35')
      assert.match(await failed.getByRole('progressbar').getAttribute('aria-valuetext'), /140 MB/)
      assert.equal(await failed.getByRole('button', { name: '继续下载', exact: true }).isVisible(), true)
    })
    await check('the active transfer exposes a named text action and correct speed unit', async () => {
      assert.match(await page.locator('[data-hero-toggle]').innerText(), /暂停/)
      const text = await page.locator('[data-hero-speed]').innerText()
      assert.match(text, /MB\/s/)
      assert.doesNotMatch(text, /MB\/S/)
      await page.locator('[data-hero-toggle]').click()
      await page.waitForFunction(() => document.querySelector('[data-hero-toggle]')?.textContent?.includes('继续'))
      await page.locator('[data-hero-toggle]').click()
      await page.waitForFunction(() => document.querySelector('[data-hero-toggle]')?.textContent?.includes('暂停'))
    })
    await check('details display the disk error rather than generic network advice', async () => {
      await row(103).click()
      await page.locator('[data-download-failure]').waitFor()
      assert.match(await page.locator('[data-download-failure]').innerText(), /磁盘空间不足/)
      await capture('02-dawn-failure-details')
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    })
    await check('refused recovery keeps the task and offers another attempt', async () => {
      await page.evaluate(() => { window.__qa.fail = 'resume' })
      await row(103).locator('..').getByRole('button', { name: '继续下载', exact: true }).click()
      await page.locator('#task-action-status').waitFor()
      assert.equal(await row(103).isVisible(), true)
      assert.match(await page.locator('#task-action-status').innerText(), /重试|未能/)
      await capture('03-recovery-refused')
      await page.getByRole('button', { name: '关闭任务操作提示' }).click()
      await page.evaluate(() => { window.__qa.fail = null })
      await row(103).locator('..').getByRole('button', { name: '继续下载', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[data-task-select="103"]')?.parentElement?.dataset.taskState === 'downloading')
      await page.evaluate(() => window.__qa.reset())
    })
    await check('protocol error tokens stay hidden in the list and details', async () => {
      await page.evaluate(() => window.__qa.update(103, { errorText: '#diag:unknownFutureReason' }))
      await row(103).click()
      await page.locator('[data-download-failure]').waitFor()
      assert.doesNotMatch(await page.locator('#task-inspector').innerText(), /#diag:/)
      assert.doesNotMatch(await row(103).locator('..').innerText(), /#diag:/)
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      await page.evaluate(() => window.__qa.reset())
    })
    await check('dark mode, resizing and inspector preserve the content boundaries', async () => {
      for (const theme of ['walnut', 'dawn']) {
        await page.goto(url + '/?theme=' + theme + platformQuery)
        await page.locator('[data-hero-state]').waitFor()
        for (const width of [1440, 1220, 920, 720]) {
          await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
          await page.waitForFunction(width => window.innerWidth === width, width)
          await page.waitForTimeout(100)
          const geometry = await page.evaluate(() => {
            const main = document.querySelector('#main-content').getBoundingClientRect()
            const hero = document.querySelector('[data-hero-state]').getBoundingClientRect()
            const table = document.querySelector('.task-table').getBoundingClientRect()
            const search = document.querySelector('[role="search"]').getBoundingClientRect()
            const rows = [...document.querySelectorAll('[data-task-state]:has(> .task-table-row)')].map(row => { const action = row.querySelector('[data-row-actions]').getBoundingClientRect(); const progress = row.querySelector('[role=progressbar]')?.getBoundingClientRect(); return { action: action.toJSON(), progress: progress?.toJSON() } });
            return { main: main.toJSON(), hero: hero.toJSON(), table: table.toJSON(), search: search.toJSON(), rows, width: innerWidth, documentWidth: document.documentElement.scrollWidth }
          })
          geometries.push({ theme, ...geometry })
          assert.equal(geometry.documentWidth, width)
          assert.ok(geometry.rows.every(row => row.action.right <= geometry.main.right + 1 && (!row.progress || row.progress.right <= row.action.x + 1)), JSON.stringify(geometry))
          assert.ok(geometry.hero.x >= geometry.main.x && geometry.hero.right <= geometry.main.right + 1, JSON.stringify(geometry))
          assert.ok(geometry.table.right <= geometry.main.right + 1, JSON.stringify(geometry))
          assert.ok(geometry.search.x >= 0 && geometry.search.right <= width + 1, JSON.stringify(geometry))
          assert.equal(await page.locator('.library-heading h1').evaluate(el => getComputedStyle(el).fontSize), '20px')
          if (width === 1440 || width === 720) await capture(`04-${theme}-${width}`)
        }
        await row(103).click()
        await page.locator('#task-inspector').waitFor()
        await page.waitForFunction(() => { const box = document.querySelector('#task-inspector')?.getBoundingClientRect(); return box && box.x >= 0 && box.right <= innerWidth + 1 })
        const box = await page.locator('#task-inspector').boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= 721)
        await capture(`05-${theme}-720-details`)
        await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      }
    })
    await check('card failures show a visible reason and retain download feedback', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1220, 820))
      await page.getByRole('button', { name: '卡片视图', exact: true }).click()
      await page.locator('[data-gallery-failure-summary]').first().waitFor()
      const summaries = await page.locator('[data-gallery-failure-summary]').allTextContents()
      assert.ok(summaries.some(text => text.includes('磁盘空间不足')))
      await capture('06-dawn-cards')
      await page.goto(url + '/?theme=walnut' + platformQuery)
      await page.getByRole('button', { name: '卡片视图', exact: true }).click()
      await page.locator('[data-gallery-failure-summary]').first().waitFor()
      await capture('07-walnut-cards')
    })
    await check('reduced motion removes passive progress effects', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: '列表视图', exact: true }).click()
      await page.locator('[data-hero-state]').waitFor()
      assert.equal(await page.locator('[data-hero-state] h2').evaluate(el => getComputedStyle(el).fontSize), '20px')
      const motion = await page.evaluate(() => [...document.querySelectorAll('[data-row-progress-fill]')].map(el => getComputedStyle(el, '::before').animationName))
      assert.ok(motion.every(name => name === 'none'))
    })
    await check('pause and count transitions always render one clear symbol and number', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1220, 780))
      await page.getByRole('button', { name: '卡片视图', exact: true }).click()
      await page.evaluate(() => { const task = window.__qa.tasks().find(task => task.id === 102); window.__qa.replace([{ ...task, filename: 'ndm-task-controls-qa.bin', title: 'ndm-task-controls-qa.bin', category: 'misc', fileSize: 64 * 1024 ** 2, completedBytes: 1.6 * 1024 ** 2 }]) })
      await page.locator('[data-gallery-select="102"]').click()
      await page.locator('#task-inspector').waitFor()
      await page.locator('#task-inspector summary').filter({ hasText: '下载设置' }).click()
      const schedule = page.locator('[data-inspector-schedule]')
      await schedule.getByRole('button', { name: '稍后开始', exact: true }).scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      const bounds = await schedule.getByRole('button', { name: '稍后开始', exact: true }).evaluate(button => {
        const rect = button.getBoundingClientRect(), pane = button.closest('.inspector-content').getBoundingClientRect()
        const content = button.closest('.animated-disclosure-content').getBoundingClientRect()
        return { rect: rect.toJSON(), pane: pane.toJSON(), content: content.toJSON() }
      })
      assert.ok(bounds.rect.bottom <= bounds.pane.bottom && bounds.rect.bottom <= bounds.content.bottom, JSON.stringify(bounds))
      await capture('08-paused-controls-unclipped')
      for (let i = 0; i < 5; i++) {
        await page.locator('[data-gallery-card="102"] [data-gallery-primary]').click()
        await page.waitForTimeout(20)
        assert.equal(await page.locator('[data-gallery-card="102"] [data-transfer-action-icon] svg').count(), 1)
        const counts = await page.locator('[data-animated-count]').evaluateAll(nodes => nodes.map(node => ({ current: node.querySelectorAll('[data-count-current]').length, outgoing: node.querySelectorAll('[data-count-outgoing]').length, value: node.dataset.countValue })))
        assert.ok(counts.every(count => count.current === 1 && count.outgoing === 0), JSON.stringify(counts))
      }
    })
    await check('completion uses the recent-file surface without toast or confetti obstruction', async () => {
      await page.evaluate(() => {
        window.__qa.update(102, { status: 'complete', completedBytes: 64 * 1024 ** 2, bytesPerSecond: 0 })
        window.__qa.emit({ op: 'downloadCompleted', task: { id: 102, filename: 'ndm-task-controls-qa.bin', folderPath: '/qa/Downloads', fullPath: '/qa/Downloads/ndm-task-controls-qa.bin' } })
      })
      await page.locator('[data-completion-feedback="library"]').waitFor()
      await page.waitForTimeout(250)
      assert.equal(await page.locator('[data-testid="completion-bar"]').count(), 0)
      assert.equal(await page.locator('[data-testid="completion-confetti"]').count(), 0)
      await capture('09-completed-without-obstruction')
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    })
    await check('secure-storage failure has one focused explanation and one save-retry action', async () => {
      await page.locator('.ndm-new-download').click()
      await page.getByRole('textbox', { name: '下载链接', exact: true }).fill('https://example.test/ndm-model-artifact-qa.gguf')
      await page.evaluate(() => { window.__qa.draftFailure = true; window.__qa.calls.length = 0 })
      await page.getByRole('button', { name: '开始下载', exact: true }).click()
      await page.locator('[data-draft-error]').waitFor()
      await page.waitForTimeout(250)
      assert.equal(await page.locator('[data-draft-error]').count(), 1)
      assert.equal(await page.locator('[data-draft-retry]').count(), 1)
      assert.equal(await page.locator('[data-batch-notice]').count(), 0)
      assert.equal(await page.getByText('未能添加，可重试', { exact: true }).count(), 0)
      const calls = await page.evaluate(() => window.__qa.calls)
      assert.equal(calls.filter(call => ['add', 'addMedia'].includes(call.op)).length, 0)
      const popup = await page.locator('.ndm-composer').boundingBox()
      assert.ok(popup.width <= 640 && popup.height < 500, JSON.stringify(popup))
      await capture('10-secure-storage-focused')
      await page.evaluate(() => { window.__qa.draftFailure = false })
      await page.locator('[data-draft-retry]').click()
      await page.waitForFunction(() => !document.querySelector('[data-draft-error]'))
      const after = await page.evaluate(() => window.__qa.calls)
      assert.equal(after.filter(call => ['add', 'addMedia'].includes(call.op)).length, 0)
      await capture('11-secure-storage-saved')
    })

  }
  if (platformQuery && !process.argv.includes('--capture-only')) {
    const zoomTo = async zoom => {
      await page.evaluate(zoom => { window.__qa.zoom = zoom }, zoom)
      await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
      await page.evaluate(() => window.dispatchEvent(new Event('resize')))
      await page.waitForFunction(zoom => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--window-controls-height')) * zoom - 52) < 0.1, zoom)
    }
    const assertSafe = async zoom => {
      await page.waitForTimeout(240)
      const result = await page.evaluate(zoom => {
        const content = document.querySelector('.ndm-workspace').getBoundingClientRect()
        const surfaces = [...document.querySelectorAll('.library-search button, .library-actions button, [role="search"], .inspector-heading button, .settings-page-header button, .workspace-dialog-viewport, .onboarding-viewport')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .filter(el => { const r = el.getBoundingClientRect(); return r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0 })
          .map(el => { const r = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') || el.className, top: r.top * zoom, right: r.right * zoom } })
        return { zoom, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, nativeLeft: innerWidth * zoom - 138, nativeBottom: 52, contentTop: content.top * zoom, extraCaptionCount: document.querySelectorAll('.ndm-window-caption').length, surfaces }
      }, zoom)
      geometries.push(result)
      assert.equal(result.scrollWidth, result.width)
      assert.equal(result.contentTop, 0)
      assert.equal(result.extraCaptionCount, 0)
      assert.ok(result.surfaces.every(surface => surface.top >= result.nativeBottom - .1 || surface.right <= result.nativeLeft + .1), JSON.stringify(result))
      const toolbar = await page.evaluate(() => {
        const search = document.querySelector('[role="search"]').getBoundingClientRect()
        const views = document.querySelector('.library-view-actions').getBoundingClientRect()
        const heading = document.querySelector('.library-heading').getBoundingClientRect()
        const layout = document.querySelector('.library-toolbar')
        return { searchCentre: search.y + search.height / 2, viewsTop: views.top, viewsLeft: views.left, headingRight: heading.right,
          inset: parseFloat(layout.style.getPropertyValue('--titlebar-controls-right-inset')) }
      })
      if (toolbar.inset > 0 && zoom <= 1) assert.ok(Math.abs(toolbar.searchCentre * zoom - 26) < .1, JSON.stringify(toolbar))
      assert.ok(toolbar.viewsLeft >= toolbar.headingRight - 1, JSON.stringify(toolbar))
      assert.ok(toolbar.viewsTop > toolbar.searchCentre, JSON.stringify(toolbar))
    }
    await check('Windows toolbar and details clear native controls across themes, widths and actual Electron zoom', async () => {
      for (const theme of ['dawn', 'walnut']) {
        await page.goto(url + '/?theme=' + theme + platformQuery)
        await page.locator('[data-hero-state]').waitFor()
        for (const width of [1440, 920, 720]) {
          await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
          for (const zoom of [.67, 1, 1.25, 1.8]) {
            await zoomTo(zoom)
            await assertSafe(zoom)
          }
          await zoomTo(1)
          await page.locator('[data-task-select="103"]').click()
          await page.locator('#task-inspector').waitFor()
          await assertSafe(1)
          if (width !== 920) await capture(`12-windows-${theme}-${width}-details`)
          await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
          if (width !== 920) await capture(`13-windows-${theme}-${width}-workspace`)
        }
      }
    })
    await check('Windows sidebar toggle and keyboard search remain usable below the caption', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1220, 780))
      await page.goto(url + '/?theme=walnut' + platformQuery)
      await page.waitForFunction(() => document.querySelector('.ndm-workspace')?.dataset.sidebarOpen === 'true')
      const before = await page.locator('.ndm-workspace').getAttribute('data-sidebar-open')
      await page.getByRole('button', { name: '切换侧栏', exact: true }).click()
      await page.waitForFunction(before => document.querySelector('.ndm-workspace').dataset.sidebarOpen !== before, before)
      await assertSafe(1)
      await page.keyboard.press('Control+f')
      assert.equal(await page.locator('#ndm-search').evaluate(el => document.activeElement === el), true)
      await page.locator('#ndm-search').fill('磁盘')
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('#ndm-search').inputValue(), '')
      await page.getByRole('button', { name: '切换侧栏', exact: true }).click()
      await page.waitForFunction(before => document.querySelector('.ndm-workspace').dataset.sidebarOpen === before, before)
    })
    await check('Windows settings, quick actions and onboarding portals share the safe top edge', async () => {
      for (const zoom of [1, 1.8]) {
        await zoomTo(zoom)
        await page.keyboard.press('Control+,')
        await page.locator('.ndm-settings').waitFor()
        await assertSafe(zoom)
        const settings = await page.locator('.ndm-settings').evaluate(el => {
          const content = el.querySelector('.settings-content')
          const done = [...el.querySelectorAll('.settings-page-header button')][0].getBoundingClientRect()
          return { contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth, done: done.toJSON(), width: innerWidth, height: innerHeight }
        })
        assert.equal(settings.contentScrollWidth, settings.contentWidth, JSON.stringify(settings))
        assert.ok(settings.done.right <= settings.width && settings.done.bottom <= settings.height, JSON.stringify(settings))
        await capture(`14-windows-settings-zoom-${zoom}`)
        await page.getByRole('button', { name: '返回应用', exact: true }).click()
        await page.locator('.ndm-settings').waitFor({ state: 'hidden' })
        await page.keyboard.press('Control+k')
        await page.locator('.workspace-dialog-viewport').waitFor()
        await assertSafe(zoom)
        await page.keyboard.press('Escape')
        await page.locator('.workspace-dialog-viewport').waitFor({ state: 'hidden' })
      }
      await zoomTo(1)
      await page.keyboard.press('Control+,')
      await page.locator('.ndm-settings').waitFor()
      await page.getByRole('button', { name: '重新引导', exact: true }).click()
      await page.locator('.onboarding-viewport').waitFor()
      await assertSafe(1)
      await capture('15-windows-onboarding')
      await page.keyboard.press('Escape')
    })
    await check('Windows fullscreen removes the in-row control reservation and restores it on exit', async () => {
      await page.evaluate(() => window.__qa.chrome({ fullScreen: true }))
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--window-controls-height') === '0px')
      assert.equal(await page.locator('.ndm-workspace').evaluate(el => el.getBoundingClientRect().top), 0)
      assert.equal(await page.locator('.library-toolbar').evaluate(el => parseFloat(el.style.getPropertyValue('--titlebar-controls-right-inset'))), 0)
      await page.evaluate(() => window.__qa.chrome({ fullScreen: false }))
      await assertSafe(1)
    })
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, geometries, testedBuild, generatedAt: new Date().toISOString(), output, platform: platformQuery ? 'win32' : 'darwin', nativeWindowsValidated: false, isolatedEngine: true, audioMuted: true }, null, 2))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ output, checks: checks.length, errors }))
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, geometries, testedBuild, failure: String(error), output, isolatedEngine: true, audioMuted: true }, null, 2))
  throw error
} finally { await app?.close().catch(() => {}); await new Promise(done => server.close(done)) }
