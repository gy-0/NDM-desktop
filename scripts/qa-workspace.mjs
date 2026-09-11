// Renderer-only regression QA: real built React UI, isolated mock preload/engine.
// Never connects to a running NDM host, reads user downloads, or changes real files.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { openDownloadSettings } from './qa-env.mjs'

const results = []
const mutationOps = ['pause', 'resume', 'remove', 'removeMany', 'restart', 'restartMany', 'pauseAll', 'resumeAll']

const output = resolve(process.env.NDM_QA_OUTPUT ?? join(tmpdir(), 'ndm-workspace-qa'))
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
      if (window.__qa.delay && ['pause', 'resume', 'remove', 'removeMany', 'setBandwidth'].includes(op)) await new Promise((done) => { pending = done })
      if (window.__qa.fail === op) throw new Error('QA injected failure')
      if (op === 'setBandwidth') {
        tasks = tasks.map((t) => t.id === extra.taskID
          ? { ...t, bandwidthLimit: extra.bandwidthLimit, effectiveBandwidthLimit: extra.bandwidthLimit }
          : t)
        snapshot()
      }
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

const search = () => page.getByRole('searchbox', { name: '搜索下载任务' })
const row = (id) => page.locator(`[data-task-select="${id}"]`)
const selected = () => page.locator('[data-task-select][aria-pressed="true"]')
const filter = (id) => page.locator(`[data-filter="${id}"]`)
async function count(selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected })
}
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' })
}
async function mutations() { return (await page.evaluate(() => window.__qa.calls)).filter((call) => mutationOps.includes(call.op)) }
async function reset(params = '') {
  await page.evaluate(() => localStorage.removeItem('ndm-task-sort'))
  await page.goto(url + params)
  await page.locator('[data-hero-state]').waitFor()
}
async function check(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, status: 'failed', error: String(error) }); throw error }
}

try {
  await page.goto(url)
  await page.locator('[data-hero-state]').waitFor()
  await screenshot('01-workspace')
  if (!process.argv.includes('--capture-only')) {
    await check('column handles track pointer pixels and share row boundaries', async () => {
      const handle = page.getByRole('separator', { name: '调整文件名列宽' })
      const before = await handle.boundingBox()
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
      await page.mouse.down()
      await page.mouse.move(before.x + before.width / 2 + 12, before.y + before.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(150)
      const after = await handle.boundingBox()
      assert.ok(Math.abs(after.x - before.x - 12) < 2, JSON.stringify({before, after, width: await handle.getAttribute("aria-valuenow"), geometry: await handle.evaluate(el => ({parent: el.parentElement.getBoundingClientRect().toJSON(),grid: getComputedStyle(el.parentElement.parentElement).gridTemplateColumns,scroller:el.parentElement.parentElement.parentElement.parentElement.scrollLeft}))}))
      const alignment = await page.evaluate(() => {
        const head = document.querySelector('.task-table-header').children
        const cells = document.querySelector('.task-table-row').children
        // Only columns that are laid out in the grid can be compared: the
        // header cell is display:none when progress stacks, and the row's
        // progress cell is absolutely positioned on its own lower line.
        return [...head]
          .map((node, i) => ({ header: node.getBoundingClientRect(), cell: cells[i]?.getBoundingClientRect() }))
          .filter((pair) => pair.header.width > 0 && (pair.cell?.width ?? 0) > 0)
          .map((pair) => Math.abs(pair.header.x - pair.cell.x))
      })
      assert.ok(alignment.length >= 3, 'grid columns are comparable')
      assert.ok(alignment.every((gap) => gap < 2), `column drift: ${JSON.stringify(alignment)}`)
      await handle.focus()
      await page.keyboard.press('ArrowLeft')
      await page.waitForTimeout(150)
      assert.ok(Math.abs((await handle.boundingBox()).x - after.x + 8) < 2)
      await handle.dblclick()
      await page.waitForTimeout(150)
      assert.ok(Math.abs((await handle.boundingBox()).x - before.x) < 2)
      assert.equal(await page.locator('html').getAttribute('data-resizing-columns'), null)
    })
    await check('live hero keeps painting between unchanged snapshots and stops when paused', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await reset()
      await page.waitForTimeout(1800)
      await screenshot('14-liquid-night')
      await page.evaluate(() => document.documentElement.dataset.theme = 'dawn')
      await page.waitForTimeout(500)
      await screenshot('15-liquid-dawn')
      await page.evaluate(() => window.__rafCount = 0)
      await page.waitForTimeout(350)
      const activeFrames = await page.evaluate(() => window.__rafCount)
      assert.ok(activeFrames > 5, `Expected live frame loop, got ${activeFrames}`)
      await page.evaluate(() => window.__qa.snapshot(window.__qa.tasks().map((t) => ({ ...t, status: 'paused', bytesPerSecond: 0 }))))
      await page.waitForTimeout(1200)
      await page.evaluate(() => window.__rafCount = 0)
      await page.waitForTimeout(350)
      const pausedFrames = await page.evaluate(() => window.__rafCount)
      assert.ok(pausedFrames < activeFrames, `Live ${activeFrames}, paused ${pausedFrames}`)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await reset()
    })
    await check('overall progress sits above segments and uses total bytes', async () => {
      await reset()
      await page.evaluate(() => window.__qa.update(101, {
        fileSize: 100, completedBytes: 50, activeRequests: 1,
        segments: [
          { id: 1, start: 0, end: 19, completed: 20, fraction: 1 },
          { id: 2, start: 20, end: 99, completed: 30, fraction: 0.375 }
        ]
      }))
      const total = page.locator('[data-hero-total-progress]')
      await total.waitFor()
      assert.match(await total.innerText(), /50\.0%/)
      assert.equal(await total.getByRole('progressbar').getAttribute('aria-valuenow'), '50')
      assert.match(await page.locator('[data-hero-segment-summary]').innerText(), /2 段 · 1 路活跃/)
      const overall = await total.getByRole('progressbar').boundingBox()
      const segments = await page.locator('[data-hero-progress] [data-progress-style="segmented"]').boundingBox()
      assert.ok(overall.y + overall.height < segments.y)
      await screenshot('16-total-and-segments')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      // A completed range must settle at 100%, even with overall progress 50%.
      // Then split only the donor's unwritten tail, without moving its prefix.
      await page.evaluate(() => window.__qa.update(101, { bytesPerSecond: 1 }))
      await page.waitForFunction(() => {
        const fills = [...document.querySelectorAll('[data-hero-progress] [data-progress-style="segmented"] [data-progress-fill]')]
        const scale = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a
        return fills.length === 2 && Math.abs(scale(fills[0]) - 1) < 0.001 && Math.abs(scale(fills[1]) - 0.375) < 0.001
      })
      await page.evaluate(() => window.__qa.update(101, { segments: [
        { id: 1, start: 0, end: 19, completed: 20, fraction: 1 },
        { id: 2, start: 20, end: 74, completed: 30, fraction: 30 / 55 },
        { id: 3, start: 75, end: 99, completed: 0, fraction: 0 }
      ] }))
      await page.waitForFunction(() => {
        const fills = [...document.querySelectorAll('[data-hero-progress] [data-progress-style="segmented"] [data-progress-fill]')]
        const scale = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a
        return fills.length === 3 && Math.abs(scale(fills[0]) - 1) < 0.001 && Math.abs(scale(fills[1]) - 30 / 55) < 0.001 && scale(fills[2]) === 0
      })
      await screenshot('16b-animated-tail-handoff')
      assert.match(await page.locator('[data-hero-segment-summary]').innerText(), /3 段 · 1 路活跃/)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => window.__qa.update(101, { segments: [{ id: 1, fraction: 0.5 }] }))
      await count('[data-hero-total-progress]', 0)
      await reset()
    })
    await check('progress effects default on, switch off immediately and persist after reload', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await reset()
      const movingFill = page.locator('[data-progress-flow="active"] [data-progress-fill]').first()
      await movingFill.waitFor()
      assert.equal(await movingFill.evaluate(el => getComputedStyle(el, '::before').animationName), 'transfer-flow')
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '下载', exact: true }).click()
      const toggle = page.getByRole('switch', { name: '进度条动效', exact: true })
      assert.equal(await toggle.getAttribute('aria-checked'), 'true')
      await toggle.click()
      await page.getByRole('button', { name: '返回应用', exact: true }).click()
      await count('[data-progress-flow="active"]', 0)
      await reset()
      await count('[data-progress-flow="active"]', 0)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '下载', exact: true }).click()
      assert.equal(await toggle.getAttribute('aria-checked'), 'false')
      await toggle.click()
      await page.getByRole('button', { name: '返回应用', exact: true }).click()
      await movingFill.waitFor()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await movingFill.evaluate(el => getComputedStyle(el, '::before').animationName), 'none')
      await reset()
    })
    await check('row actions leave live progress visible and do not overlap it', async () => {
      await row(108).hover()
      const track = row(108).getByRole('progressbar')
      await track.waitFor()
      assert.equal(await track.evaluate(el => getComputedStyle(el.parentElement).opacity), '1')
      const progress = await track.boundingBox()
      const actions = await row(108).locator('..').locator('[data-row-actions]').boundingBox()
      assert.ok(actions.y + actions.height <= progress.y + 1)
    })
    await check('hover actions never paint over the values they cover', async () => {
      await reset()
      // 104 is complete (no progress bar), so every trailing column keeps its
      // text vertically centred where the buttons land. The earlier build put
      // 安装 and 2.8 MB straight on top of 可安装 and the size value.
      await row(104).hover()
      // The covered values fade over 100ms; measure the settled frame.
      await page.waitForFunction(() => {
        const row = document.querySelector('[data-task-select="104"]')?.parentElement?.querySelector('.task-table-row')
        if (!row) return false
        return [...row.children].slice(1).some((cell) => Number(getComputedStyle(cell).opacity) === 0)
      })
      const overlap = await page.evaluate(() => {
        const button = document.querySelector('[data-task-select="104"]')
        const wrap = button?.parentElement
        const actions = wrap?.querySelector('[data-row-actions]')
        if (!button || !actions) return null
        const buttons = actions.getBoundingClientRect()
        return [...button.children].slice(1).map((cell) => {
          const rect = cell.getBoundingClientRect()
          const opacity = Number(getComputedStyle(cell).opacity)
          const text = (cell.textContent ?? '').trim()
          return { text, opacity, past: Math.round(rect.right - buttons.left), fading: cell.className.includes('group-hover:opacity-0') }
        })
      })
      assert.ok(overlap, 'row geometry is readable')
      const collisions = overlap.filter((cell) => cell.text && cell.opacity > 0.5 && cell.past > 1)
      assert.deepEqual(collisions, [], `painted under the buttons: ${JSON.stringify(overlap)}`)
      const fading = overlap.filter((cell) => cell.fading)
      assert.ok(fading.length > 0, 'at least one covered value fades instead of hiding the actions')
      assert.ok(fading.every((cell) => cell.opacity === 0), `covered values fade on hover: ${JSON.stringify(overlap)}`)
      await screenshot('18-row-actions')
      await row(108).hover()
      const keptProgress = await page.evaluate(() => {
        const cell = document.querySelector('[data-task-select="108"]')?.parentElement?.querySelector('.task-row-progress')
        return cell ? Number(getComputedStyle(cell).opacity) : null
      })
      assert.equal(keptProgress, 1, 'a transferring row keeps its progress line while the actions show')
      await reset()
    })
    await check('the details toggle owns the top-right corner and search is a 32px field', async () => {
      await reset()
      const chrome = await page.evaluate(() => {
        const row = document.querySelector('.library-search')
        const field = row?.querySelector('[role="search"]')
        const input = document.querySelector('#ndm-search')
        const controls = [...(row?.querySelectorAll('button') ?? [])].map((button) => {
          const rect = button.getBoundingClientRect()
          return { label: button.getAttribute('aria-label'), x: Math.round(rect.x), height: Math.round(rect.height) }
        })
        return {
          fieldHeight: field ? Math.round(field.getBoundingClientRect().height) : 0,
          inputFontSize: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
          controls
        }
      })
      assert.equal(chrome.fieldHeight, 32, 'search field shares the control row height')
      assert.ok(chrome.inputFontSize <= 12.5, `search text stays at the label role: ${chrome.inputFontSize}`)
      const rightmost = [...chrome.controls].sort((a, b) => b.x - a.x)[0]
      assert.equal(rightmost.label, '切换任务详情', 'details toggle is the right-most control')
      assert.equal(chrome.controls.find((control) => control.label === '排序下载任务').x < rightmost.x, true)
      await screenshot('19-toolbar')
    })
    await check('per-task limit paints the tier before the engine answers and still rolls back', async () => {
      await reset()
      await row(102).click()
      // Download settings live behind a disclosure so the pane opens quiet.
      await openDownloadSettings(page)
      const group = page.getByRole('group', { name: '此任务限速' })
      const five = group.getByRole('button', { name: '5 MB/s' })
      const ten = group.getByRole('button', { name: '10 MB/s' })
      const unlimited = group.getByRole('button', { name: '跟随全局', exact: true })
      await five.waitFor()
      assert.equal(await unlimited.getAttribute('aria-pressed'), 'true')
      // Hold the acknowledgement: the control used to dim and only slide after
      // the round trip, which read as a flicker followed by a delayed slider.
      await page.evaluate(() => { window.__qa.delay = 1 })
      await five.click()
      await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="此任务限速"] button[aria-label="5 MB/s"]')?.getAttribute('aria-pressed') === 'true')
      assert.equal(await group.getAttribute('aria-busy'), 'true', 'the save is still in flight while the tier is already painted')
      assert.equal(await five.isDisabled(), false, 'controls never dim while saving')
      await page.evaluate(() => { window.__qa.delay = 0; window.__qa.release() })
      await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="此任务限速"]')?.getAttribute('aria-busy') === 'false')
      assert.equal(await five.getAttribute('aria-pressed'), 'true')
      assert.equal(await group.getAttribute('data-task-bandwidth'), '5242880')
      // A custom speed the presets cannot express.
      const field = group.getByRole('textbox', { name: '自定义任务限速，每秒 MB' })
      await field.fill('2.5')
      await field.press('Enter')
      await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="此任务限速"]')?.getAttribute('data-task-bandwidth') === '2621440')
      assert.ok((await group.innerText()).includes('当前限制为 2.5 MB/s'), await group.innerText())
      assert.equal(await unlimited.getAttribute('aria-pressed'), 'false')
      const recorded = await page.evaluate(() => window.__qa.calls.filter((call) => call.op === 'setBandwidth'))
      assert.deepEqual(recorded.map((call) => call.bandwidthLimit), [5242880, 2621440])
      // Out-of-range input is refused before it reaches the engine.
      await field.fill('0.001')
      await field.press('Enter')
      await page.waitForFunction(() => document.querySelector('#task-bandwidth-status')?.textContent?.includes('限速需在'))
      assert.equal(await field.getAttribute('aria-invalid'), 'true')
      assert.equal(await page.evaluate(() => window.__qa.calls.filter((call) => call.op === 'setBandwidth').length), 2)
      await field.fill('2.5')
      // A refused engine write restores the acknowledged value.
      await page.evaluate(() => { window.__qa.fail = 'setBandwidth' })
      await ten.click()
      await page.waitForFunction(() => document.querySelector('#task-bandwidth-status')?.textContent?.includes('未能保存'))
      assert.equal(await ten.getAttribute('aria-pressed'), 'false')
      assert.equal(await group.getAttribute('data-task-bandwidth'), '2621440')
      assert.equal(await group.getAttribute('aria-busy'), 'false')
      assert.equal(await ten.isDisabled(), false)
      await page.evaluate(() => { window.__qa.fail = null })
      await screenshot('20-task-limit')
      await reset()
    })
    await check('failure details read on the pane surface with one colored mark', async () => {
      await reset()
      await row(103).click()
      const block = page.locator('[data-download-failure]')
      await block.waitFor()
      const surface = await block.evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          background: style.backgroundColor,
          borderTopWidth: style.borderTopWidth,
          borderTopColor: style.borderTopColor,
          radius: style.borderTopLeftRadius,
          hueMarks: el.querySelectorAll('.text-clay').length,
          text: (el.textContent ?? '').trim()
        }
      })
      assert.equal(surface.background, 'rgba(0, 0, 0, 0)', 'the explanation keeps the pane surface')
      assert.equal(surface.borderTopWidth, '1px')
      assert.equal(surface.radius, '0px', 'no nested alert card')
      assert.ok(surface.hueMarks >= 1, 'a mark still carries the severity')
      assert.ok(surface.text.includes('磁盘空间不足'), surface.text)
      await screenshot('21-failure-details')
      // Two pane captures: the failure block and the download settings above it.
      const audit = await page.evaluate(() => {
        const pane = document.querySelector('#task-inspector')
        const sizes = new Set()
        const radii = new Set()
        for (const node of pane.querySelectorAll('*')) {
          if (!(node instanceof HTMLElement) || !node.offsetParent) continue
          const style = getComputedStyle(node)
          if ((node.textContent ?? '').trim() && node.children.length === 0) sizes.add(style.fontSize)
          const radius = parseFloat(style.borderTopLeftRadius)
          // Dots and tracks use rounded-full, which resolves to a huge radius.
          if (radius > 0 && radius < 1000) radii.add(style.borderTopLeftRadius)
        }
        return { sizes: [...sizes].sort(), radii: [...radii].sort() }
      })
      assert.ok(audit.sizes.length <= 6, `pane type scale drifted: ${audit.sizes.join(', ')}`)
      // The same grammar must hold on the light surface.
      await reset('?theme=dawn')
      await row(103).click()
      await page.locator('[data-download-failure]').waitFor()
      const dawn = await page.locator('[data-download-failure]').evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        mark: el.querySelectorAll('.text-clay').length
      }))
      assert.equal(dawn.background, 'rgba(0, 0, 0, 0)')
      assert.ok(dawn.mark >= 1)
      await screenshot('21b-failure-details-dawn')
      assert.deepEqual([...audit.radii].sort((a, b) => parseFloat(a) - parseFloat(b)), ['7px', '12px'], `pane radii are controls 7 / surfaces 12: ${audit.radii.join(', ')}`)
      await reset()
    })
    await check('Inspector has a named close action and restores its default width', async () => {
      await page.setViewportSize({width: 1600, height: 900})
      await row(102).click()
      const handle = page.getByRole('separator', {name: '调整任务详情宽度'})
      await handle.focus()
      await page.keyboard.press('ArrowLeft')
      await handle.dblclick()
      await page.waitForFunction(() => document.querySelector('[aria-label="调整任务详情宽度"]')?.getAttribute('aria-valuenow') === '360')
      await page.getByRole('button', {name: '关闭任务详情', exact: true}).click()
      await page.locator('#task-inspector').waitFor({state: 'hidden'})
      await page.setViewportSize({width: 1280, height: 820})
      await reset()
    })
    await check('Inspector updates live request counts independently of byte progress', async () => {
      await row(102).click()
      await openDownloadSettings(page)
      await page.evaluate(() => window.__qa.update(102, { status: 'downloading', connections: 32, activeRequests: 4, requestLimit: 4 }))
      await page.locator('#task-inspector').getByText('当前活跃 4 路 · 暂限 4 路', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.update(102, { activeRequests: 3 }))
      await page.locator('#task-inspector').getByText('当前活跃 3 路 · 暂限 4 路', { exact: true }).waitFor()
      await reset()
    })
    await check('copy feedback holds its width and only confirms acknowledged writes', async () => {
      await row(102).click()
      // Copy feedback is shared by the visible file-information fields.
      const copy = page.locator('#task-inspector .copy-feedback:visible').first()
      const button = copy.getByRole('button')
      const before = await button.boundingBox()
      await page.evaluate(() => window.__qa.fail = 'copy')
      await button.click()
      await copy.getByRole('status').filter({hasText:'复制失败，请重试'}).waitFor()
      assert.equal(await copy.getAttribute('data-copied'), 'false')
      await page.evaluate(() => window.__qa.fail = null)
      await button.click()
      await page.waitForFunction(() => Boolean(document.querySelector('#task-inspector .copy-feedback[data-copied="true"]')))
      const after = await button.boundingBox()
      assert.ok(Math.abs(before.width - after.width) < 1)
      assert.equal(await copy.getByRole('status').textContent(), '已复制')
      await page.waitForFunction(() => Boolean(document.querySelector('#task-inspector .copy-feedback[data-copied="false"]')))
      await reset()
    })
    await check('list copy icon has intermediate frames and respects reduced motion', async () => {
      await page.emulateMedia({reducedMotion:'no-preference'})
      await reset()
      await row(102).hover()
      const samples = await page.evaluate(async () => {
        const row = document.querySelector('[data-task-select="102"]').parentElement
        const button = row.querySelector('[aria-label="复制链接"]')
        const icon = row.querySelector('[data-copy-icon="done"]')
        const values = []
        button.click()
        const start = performance.now()
        while(performance.now()-start<450) {
          await new Promise(requestAnimationFrame)
          values.push(Number(getComputedStyle(icon).opacity))
        }
        return values
      })
      assert.ok(samples.some(value=>value>0.03&&value<0.97), JSON.stringify(samples))
      assert.ok(samples.at(-1)>.99)
      await page.emulateMedia({reducedMotion:'reduce'})
      await reset()
      await row(102).hover()
      await page.locator('[data-task-state]').filter({has:row(102)}).getByRole('button',{name:'复制链接',exact:true}).click()
      await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('[data-task-select="102"]').parentElement.querySelector('[data-copy-icon="done"]')).opacity)===1)
      await reset()
    })
    await check('startup waits for the first snapshot before showing an empty library', async () => {
      await page.goto(url + '?qaPendingLibrary=1')
      await page.getByRole('heading', {name: '正在读取任务库'}).waitFor()
      assert.equal(await page.getByRole('heading', {name: '从一个链接开始'}).count(), 0)
      await page.getByRole('heading', {name: '从一个链接开始'}).waitFor()
      assert.equal(await page.getByRole('heading', {name: '正在读取任务库'}).count(), 0)
      await reset()
    })
    await check('table fits its pane throughout resize and details never cover rows', async () => {
      for (const detailsOpen of [false, true]) {
        if (detailsOpen) await row(102).click()
        for (const width of [...new Set([...Array.from({length: 23}, (_, i) => 920 + i * 40), 1024, 1220])]) {
          await page.setViewportSize({width, height: 820})
          await page.waitForTimeout(120)
          const geometry = await page.evaluate(() => {
            const main = document.querySelector('#main-content').getBoundingClientRect()
            const header = document.querySelector('.task-table-header')
            const last = header.lastElementChild.getBoundingClientRect()
            const table = document.querySelector('.task-table')
            const pane = document.querySelector('#task-inspector')
            const details = pane?.getBoundingClientRect()
            return {titleSize: getComputedStyle(document.querySelector('.library-toolbar h1')).fontSize, right: main.right, last: last.right, overflow: table.scrollWidth - table.clientWidth, covered: details ? main.right - details.left : 0, overlay: pane?.hasAttribute('data-overlay') ?? false, paneRight: details?.right ?? 0, viewport: innerWidth, width: header.firstElementChild.getBoundingClientRect().width}
          })
          assert.ok(geometry.last <= geometry.right + 1, JSON.stringify({width, detailsOpen, geometry}))
          assert.equal(geometry.titleSize, '20px')
          assert.equal(await page.getByRole('button', {name:'键盘快捷键', exact:true}).count(), 0)
          assert.ok(geometry.overflow <= 1)
          // Narrow panes hand the tables to an overlay pane on purpose, so the
          // invariant is either "no overlap" or "the overlay stays on screen".
          if (geometry.overlay) assert.ok(geometry.paneRight <= geometry.viewport + 1, JSON.stringify({width, detailsOpen, geometry}))
          else assert.ok(geometry.covered <= 1, JSON.stringify({width, detailsOpen, geometry}))
          if ([920, 1024, 1220, 1440, 1800].includes(width)) await screenshot(`responsive-${width}-${detailsOpen ? 'details' : 'list'}`)
        }
      }
      await page.getByRole('button', {name: '关闭任务详情', exact:true}).click()
      await page.setViewportSize({width:1280,height:820})
      await reset()
    })
    await check('search contains only matches and moves the Hero into results', async () => {
      await search().fill('design handbook')
      await count('[data-task-select]', 1)
      assert.equal(await row(102).count(), 1)
      assert.equal(await page.locator('[data-hero-state]').count(), 0)
      await search().fill('ＢＬＥＮＤＥＲ')
      await row(101).waitFor()
      await count('[data-task-select]', 1)
      assert.equal(await page.locator('[data-hero-state]').count(), 0)
    })
    await check('no-result state offers recovery, not first-run instructions', async () => {
      await search().fill('not-a-real-download')
      await page.getByRole('heading', { name: '没有找到匹配的下载' }).waitFor()
      assert.equal(await page.getByText('从一个链接开始', { exact: true }).count(), 0)
      await screenshot('02-search-empty')
      await page.getByRole('search').getByRole('button', { name: '清除搜索' }).click()
      assert.equal(await search().inputValue(), '')
      assert.equal(await search().evaluate((el) => el === document.activeElement), true)
    })
    await check('a paused spotlight cannot disappear in the paused filter', async () => {
      await page.getByRole('button', { name: '暂停下载', exact: true }).first().click()
      await page.locator('[data-hero-state="paused"]').waitFor()
      await filter('paused').click()
      await row(101).waitFor()
      await count('[data-task-select]', 3)
      assert.equal(await page.locator('[data-hero-state]').count(), 0)
    })
    await check('search-all recovery preserves the query and changes only the scope', async () => {
      await filter('audio').click()
      await search().fill('handbook')
      await page.getByRole('button', { name: '在全部下载中搜索' }).click()
      await row(102).waitFor()
      assert.equal(await search().inputValue(), 'handbook')
      assert.equal(await filter('all').getAttribute('aria-pressed'), 'true')
    })
    await reset()
    await check('sort menu uses keyboard focus, radio state and persisted task order', async () => {
      await search().fill('example.com')
      await page.getByRole('button', { name: '排序下载任务' }).click()
      await page.getByRole('menu').waitFor()
      await screenshot('03-sort-menu')
      await page.getByRole('menuitemradio', { name: '文件名 A → Z', exact: true }).click()
      await page.waitForFunction(() => localStorage.getItem('ndm-task-sort') === JSON.stringify({ key: 'filename', direction: 'asc' }))
      const names = await page.locator('[data-task-title]').allTextContents()
      // Existing zh-Hans-CN collation puts this Chinese filename before Latin names.
      assert.deepEqual(names.slice(0, 3), ['项目交付说明.md', 'Blender-4.3-macOS.dmg', 'Creative workflow.mp4'])
      await page.reload()
      await page.getByRole('button', { name: '排序下载任务' }).click()
      assert.equal(await page.getByRole('menuitemradio', { name: '文件名 A → Z', exact: true }).getAttribute('aria-checked'), 'true')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '排序下载任务')
    })
    await check('Cmd+F is discoverable and Escape clears before leaving search', async () => {
      await page.keyboard.press('Meta+f')
      assert.equal(await search().evaluate((el) => el === document.activeElement), true)
      await search().fill('handbook')
      await page.keyboard.press('Escape')
      assert.equal(await search().inputValue(), '')
      assert.equal(await search().evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press('Escape')
      assert.equal(await search().evaluate((el) => el === document.activeElement), false)
    })
    await check('Cmd+A includes the task shown in the Hero', async () => {
      await page.getByRole('heading', { name: '全部下载', exact: true }).click()
      await page.keyboard.press('Meta+a')
      await page.getByText('已选 8 项', { exact: true }).waitFor()
      assert.equal(await selected().count(), 7)
      await screenshot('04-batch-selection')
      const bar = await page.getByRole('toolbar', { name: '批量任务操作' }).boundingBox()
      const hero = await page.locator('[data-hero-state]').boundingBox()
      assert.ok(bar.y + bar.height <= hero.y + 1, 'selection bar must not cover the Hero')
    })
    await check('Shift arrows grow and shrink a stable range', async () => {
      await search().fill('example.com')
      await row(101).click()
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+ArrowDown')
      await count('[data-task-select][aria-pressed="true"]', 4)
      await page.keyboard.press('Shift+ArrowUp')
      await count('[data-task-select][aria-pressed="true"]', 3)
    })
    await reset()
    await check('long libraries stay viewport-bounded and virtualized after deselection', async () => {
      await page.evaluate(() => {
        const task = window.__qa.tasks().find((t) => t.id === 102)
        window.__qa.snapshot(Array.from({ length: 80 }, (_, i) => ({ ...task, id: 1000 + i,
          filename: `Item-${i}.pdf`, activityAt: Date.now() - i })))
      })
      for (const width of [1280, 920]) {
        await page.setViewportSize({ width, height: 820 })
        await row(1000).click()
        await page.locator('#task-inspector').waitFor()
        await page.keyboard.press('Escape')
        await page.locator('#task-inspector').waitFor({ state: 'hidden' })
        await page.waitForFunction(() => {
          const main = document.getElementById('main-content')
          const list = main.querySelector('section')
          return main.getBoundingClientRect().height <= innerHeight + 1 &&
            list.clientHeight < list.scrollHeight && document.querySelectorAll('[data-task-select]').length < 40
        })
        await page.locator('main section').evaluate((el) => { el.scrollTop = el.scrollHeight })
        await row(1079).waitFor()
        await page.locator('main section').evaluate((el) => { el.scrollTop = 0 })
        await row(1000).waitFor()
      }
      await screenshot('12-long-library')
    })
    await page.setViewportSize({ width: 1280, height: 820 })
    await reset()
    await check('batch failure and pending state survive successful rows leaving the filter', async () => {
      await filter('paused').click()
      await row(102).click()
      await row(106).click({ modifiers: ['Meta'] })
      await page.evaluate(() => {
        const original = window.ndm.request
        window.ndm.request = async (op, extra) => {
          if (op === 'resume' && extra.taskID === 106) {
            await new Promise((resolve) => { window.__qa.finishBatchProbe = resolve })
            throw new Error('isolated batch failure')
          }
          return original(op, extra)
        }
        window.__qa.restoreRequest = () => { window.ndm.request = original }
      })
      const toolbar = page.getByRole('toolbar', { name: '批量任务操作' })
      await toolbar.getByRole('button', { name: '全部继续', exact: true }).click()
      await row(102).waitFor({ state: 'hidden' })
      assert.equal(await toolbar.getAttribute('aria-busy'), 'true')
      await page.waitForFunction(() => Boolean(window.__qa.finishBatchProbe))
      await page.evaluate(() => window.__qa.finishBatchProbe())
      await page.getByText('只继续了 1/2 个任务。请检查剩余任务后重试。', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.update(106, { completedBytes: 123 }))
      assert.ok(await page.locator('#batch-task-action-status').isVisible())
      await screenshot('13-partial-batch-failure')
      await page.evaluate(() => window.__qa.restoreRequest())
      await toolbar.getByRole('button', { name: '全部继续', exact: true }).click()
      await toolbar.waitFor({ state: 'hidden' })
      await row(106).waitFor({ state: 'hidden' })
    })
    await reset()
    await check('IME key events cannot act on selected downloads', async () => {
      await row(102).click()
      const before = await mutations()
      await row(102).evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', isComposing: true, bubbles: true })))
      await row(102).evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
      assert.equal(await page.getByRole('alertdialog').count(), 0)
      assert.deepEqual(await mutations(), before)
    })
    await check('shortcut dialog traps focus and does not leak task shortcuts', async () => {
      await row(102).focus()
      await page.keyboard.press('?')
      const dialog = page.getByRole('dialog', { name: '键盘快捷键', exact: true })
      await dialog.waitFor()
      await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role="dialog"]')))
      const before = await mutations()
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
        // Base UI focus guards redirect focus after the key event settles.
        await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role="dialog"]')))
      }
      await page.keyboard.press('Delete')
      await page.keyboard.press('Meta+n')
      assert.deepEqual(await mutations(), before)
      await screenshot('05-shortcuts')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await row(102).evaluate((el) => el === document.activeElement), true)
    })
    await check('settings owns keyboard and native menu events while open', async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      const back = page.getByRole('button', { name: '返回应用', exact: true })
      await back.waitFor()
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button').first().focus()
      const before = await mutations()
      await page.keyboard.press('Delete')
      await page.evaluate(() => window.__qa.menu('new-download'))
      assert.deepEqual(await mutations(), before)
      assert.equal(await page.getByRole('alertdialog').count(), 0)
      await back.click()
      await back.waitFor({ state: 'hidden' })
    })
    await check('delete dialog defaults to Cancel and keeps Tab focus inside', async () => {
      await row(102).click()
      await page.keyboard.press('Delete')
      const dialog = page.getByRole('alertdialog')
      await dialog.waitFor()
      await page.waitForFunction(() => document.activeElement?.textContent === '取消')
      await screenshot('06-delete-confirmation')
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')))
      }
      const before = await mutations()
      await dialog.getByRole('button', { name: '取消', exact: true }).focus()
      await page.keyboard.press('Enter')
      await dialog.waitFor({ state: 'hidden' })
      assert.deepEqual(await mutations(), before)
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-task-select') === '102')
    })
    await check('actual destructive choice drives busy text; Escape cannot dismiss in flight', async () => {
      await row(102).click()
      await page.keyboard.press('Delete')
      const dialog = page.getByRole('alertdialog')
      await page.evaluate(() => { window.__qa.delay = 1; window.__qa.fail = 'remove' })
      await dialog.getByRole('button', { name: /^同时移到废纸篓/ }).click()
      await dialog.getByText('正在移到废纸篓…', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await dialog.count(), 1)
      const calls = await mutations()
      assert.deepEqual(calls.at(-1), { op: 'remove', taskID: 102, deleteFile: true })
      await page.evaluate(() => { window.__qa.delay = 0; window.__qa.release() })
      await page.waitForFunction(() => (document.querySelector('#delete-tasks-status')?.textContent || '').length > 0)
      assert.equal(await row(102).count(), 1, 'failed deletion must preserve the task')
      await screenshot('07-delete-error')
      await page.evaluate(() => { window.__qa.fail = null })
      await dialog.getByRole('button', { name: /^仅从列表移除/ }).click()
      await dialog.waitFor({ state: 'hidden' })
      await row(102).waitFor({ state: 'hidden' })
      assert.deepEqual((await mutations()).at(-1), { op: 'remove', taskID: 102, deleteFile: false })
    })
    await reset()
    await check('search stays visible at narrow widths with the Inspector open', async () => {
      await page.setViewportSize({ width: 800, height: 720 })
      await search().fill('handbook')
      await row(102).click()
      await page.locator('#task-inspector').waitFor()
      const savedWidth = await page.evaluate(() => localStorage.getItem('ndm.inspector.width'))
      for (const width of [800, 920]) {
        await page.setViewportSize({ width, height: 720 })
        // Selection and container queries settle after the click. Observe the
        // final geometry, not an intermediate frame of the opening split.
        await page.waitForFunction(() => {
          const field = document.getElementById('ndm-search')?.getBoundingClientRect()
          const main = document.getElementById('main-content')?.getBoundingClientRect()
          const details = document.getElementById('task-inspector')?.getBoundingClientRect()
          // Either the pane splits the workspace or it overlays it on purpose;
          // what must hold is that the search field stays fully on screen.
          const placed = document.getElementById('task-inspector')?.hasAttribute('data-overlay') || details.left >= main.right - 1
          return field && main && details && field.width > 80 && field.left >= 0 &&
            field.right <= innerWidth && placed &&
            Math.abs(details.top - main.top) < 2 && main.height >= 240 && details.height >= 200
        })
        await screenshot(width === 800 ? '08-narrow-inspector' : '08b-minimum-window')
      }
      await page.setViewportSize({ width: 1280, height: 820 })
      await page.waitForFunction(() => {
        const main = document.getElementById('main-content')?.getBoundingClientRect()
        const details = document.getElementById('task-inspector')?.getBoundingClientRect()
        return main && details && details.left >= main.right - 1 && Math.abs(details.top - main.top) < 2
      })
      assert.equal(await page.evaluate(() => localStorage.getItem('ndm.inspector.width')), savedWidth,
        'responsive layout must not overwrite the saved Inspector width')
    })
    await page.setViewportSize({ width: 1280, height: 820 })
    await reset()
    await check('matching collection children are revealed without changing saved expansion', async () => {
      await page.evaluate(() => window.__qa.snapshot(window.__qa.tasks().map((t) => [102, 106].includes(t.id)
        ? { ...t, collection: { id: 'course', title: 'Visual craft course', index: t.id === 102 ? 1 : 2, count: 2 } } : t)))
      await row(102).waitFor({ state: 'hidden' })
      await search().fill('handbook')
      await row(102).waitFor()
      assert.equal(await row(106).count(), 0)
      await search().fill('')
      await row(102).waitFor({ state: 'hidden' })
    })
    await reset('?theme=dawn')
    await check('light theme uses the same workspace surfaces', async () => {
      await page.getByRole('button', { name: '排序下载任务' }).click()
      await page.getByRole('menu').waitFor()
      await screenshot('09-light-theme')
      await page.keyboard.press('Escape')
    })
    await reset('?qaPlatform=win32')
    await check('Windows shortcuts and file manager names reflect the platform', async () => {
      await row(102).focus()
      await page.keyboard.press('?')
      const dialog = page.getByRole('dialog', { name: '键盘快捷键', exact: true })
      await dialog.waitFor()
      assert.ok((await dialog.textContent()).includes('Ctrl'))
      assert.ok((await dialog.textContent()).includes('文件资源管理器'))
      assert.ok(!(await dialog.textContent()).includes('⌘'))
      await screenshot('10-windows-shortcuts')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.keyboard.press('Control+f')
      assert.equal(await search().evaluate((el) => el === document.activeElement), true)
    })
    await check('settings surfaces remain readable in both themes and narrow windows', async () => {
      for (const theme of ['dawn', 'walnut']) {
        await reset(`?theme=${theme}`)
        await page.getByRole('button', { name: '设置', exact: true }).click()
        const nav = page.getByRole('navigation', { name: '设置分类' })
        for (const label of ['通用', '外观与声音', '下载', '网络', '浏览器扩展']) {
          const target = nav.getByRole('button', {name: label, exact: true})
          await target.click()
          await page.waitForFunction(label => document.querySelector('[aria-label="设置分类"] [aria-current="page"]')?.textContent === label, label)
          await screenshot(`craft-settings-${theme}-${label}`)
        }
        await page.setViewportSize({width:920,height:780})
        await nav.getByRole('button', {name:'下载',exact:true}).click()
        assert.equal(await page.locator('.settings-content').evaluate(e=>e.scrollWidth>e.clientWidth+1),false)
        await screenshot(`craft-settings-${theme}-narrow`)
        await page.getByRole('button', {name:'返回应用',exact:true}).click()
        await page.setViewportSize({width:1280,height:820})
      }
      await reset()
    })
    await check('Relay readiness reflects connection, disconnection and unavailable status', async () => {
      await reset()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '浏览器扩展', exact: true }).click()
      const status = page.locator('[data-relay-connection-status]')
      await status.getByText('等待浏览器连接', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge = { available: true, connectedClients: 1 })
      await status.getByText('已连接 · 版本未确认', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge = { available: true, connectedClients: 2, expectedRelayVersion: '1.4.4', relayClients: [{ version: '1.4.4', protocol: 1, role: 'worker' }] })
      await status.getByText('已连接', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge.relayClients.push({ version: '1.4.3', protocol: 1, role: 'worker' }))
      await status.getByText('扩展需要更新', { exact: true }).waitFor()
      await page.locator('[data-relay-version-hint]').getByText('检测到不同版本的扩展，请从当前应用的扩展目录重新加载旧版。', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge.expectedRelayVersion = null)
      await status.getByText('已连接 · 版本未确认', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge = { available: true, connectedClients: 0 })
      await status.getByText('等待浏览器连接', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.relayBridge = { available: false, connectedClients: 0 })
      await status.getByText('桥接未就绪', { exact: true }).waitFor()
      await page.evaluate(() => window.__qa.fail = 'getBridgeStatus')
      await status.getByText('状态暂不可用', { exact: true }).waitFor()
      await reset()
    })
    await check('empty library is distinct from an empty search and offers a real action', async () => {
      await page.evaluate(() => window.__qa.snapshot([]))
      await page.getByRole('heading', { name: '从一个链接开始' }).waitFor()
      await screenshot('11-first-download')
      await page.getByRole('main').getByRole('button', { name: '添加下载', exact: true }).click()
      await page.getByPlaceholder('粘贴下载链接、磁力链或整段分享口令...').waitFor()
    })
    assert.deepEqual(errors, [], 'no renderer exceptions')
  }
  console.log(JSON.stringify({ output, passed: results.length, rendererErrors: errors }))
} catch (error) {
  await screenshot('failure').catch(() => {})
  await writeFile(join(output, 'failure.txt'), `${error.stack || error}\n\n${await page.locator('body').innerText().catch(() => '')}`)
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, rendererErrors: errors }, null, 2))
  await browser.close()
  server.closeAllConnections?.()
  await new Promise((done) => server.close(done))
}
