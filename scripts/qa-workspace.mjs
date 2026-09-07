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
  args: ['--no-sandbox']
})
const errors = []
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
page.on('pageerror', (error) => errors.push(error.message))

await page.addInitScript(() => {
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
    readClipboard: async () => '', writeClipboard: async (text) => { calls.push({ op: 'copy', text }) },
    loadFileThumbnail: async () => null, loadThumbnail: async () => null,
    extensionPath: async () => '/qa/NDMRelay',
    openPath: async (path) => { calls.push({ op: 'openPath', path }); return '' },
    revealFile: async (path) => { calls.push({ op: 'revealFile', path }); return '' },
    quickLook: async (path) => { calls.push({ op: 'quickLook', path }); return true },
    request: async (op, extra = {}) => {
      if (op === 'list') return { tasks: structuredClone(tasks) }
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

const search = () => page.getByRole('searchbox', { name: '搜索下载任务' })
const row = (id) => page.locator(`[data-task-select="${id}"]`)
const selected = () => page.locator('[data-task-select][aria-pressed="true"]')
const filter = (id) => page.locator(`[data-filter="${id}"]`)
async function count(selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected })
}
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, `${name}.png`) })
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
    await check('IME key events cannot act on selected downloads', async () => {
      await row(102).click()
      const before = await mutations()
      await row(102).evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', isComposing: true, bubbles: true })))
      await row(102).evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
      assert.equal(await page.getByRole('alertdialog').count(), 0)
      assert.deepEqual(await mutations(), before)
    })
    await check('shortcut dialog traps focus and does not leak task shortcuts', async () => {
      await page.getByRole('button', { name: '键盘快捷键', exact: true }).click()
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
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '键盘快捷键')
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
          return field && main && details && field.width > 80 && field.left >= 0 &&
            field.right <= innerWidth && details.top >= main.bottom - 1 &&
            Math.abs(details.width - main.width) < 2 && main.height >= 240 && details.height >= 200
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
      await page.getByRole('button', { name: '键盘快捷键', exact: true }).click()
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
