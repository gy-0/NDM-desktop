// Real built renderer, mock preload only. Width / 1.25 cases simulate reduced CSS
// space at 125% scaling; this is NOT an assertion about Electron OS zoom behavior.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
const output = process.env.NDM_QA_OUTPUT || join(tmpdir(), 'ndm-compact-transfer-qa')
await mkdir(output, { recursive: true })
const renderer = resolve(process.env.NDM_QA_RENDERER || 'out/renderer')
const browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) })
const page = await browser.newPage({ reducedMotion: 'reduce' })
const rows = [], failures = [], errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const requested = new URL(route.request().url())
  if (requested.origin !== 'http://fixture.test') return route.abort()
  const file = resolve(renderer, '.' + (requested.pathname === '/' ? '/index.html' : requested.pathname))
  if (!file.startsWith(renderer + sep)) return route.abort()
  try { await route.fulfill({ path: file }) } catch { await route.fulfill({ status: 404, body: '' }) }
})
await page.addInitScript(() => {
  localStorage.setItem('ndm.onboarded', '1')
  let task = { id: 81722, filename: 'A deliberately long filename for a working download.zip', title: '', folderPath: '/qa/Downloads',
    url: 'https://fixture.invalid/file.zip', source: 'fixture.invalid', category: 'compressed', connections: 8, segments: [],
    fileSize: 100 * 1024 ** 2, completedBytes: 20 * 1024 ** 2, bytesPerSecond: 8 * 1024 ** 2, status: 'downloading' }
  const hero = { ...task, id: 81721, filename: 'Hero.bin', completedBytes: 80 * 1024 ** 2, activityAt: 9999999999999 }
  const collection = [1, 2].map(index => ({ ...task, id: 81800 + index, status: 'paused', bytesPerSecond: 0, filename: `Collection episode ${index}.mp4`, collection: { id: 'metrics-course', title: 'A long collection title for layout verification', index, count: 2 } }))
  const all = () => [hero, task, ...collection]
  const listeners = new Set()
  window.__patch = patch => { task = { ...task, ...patch }; listeners.forEach(cb => cb({ op: 'snapshot', tasks: all() })) }
  window.ndm = { platform: 'darwin', version: 'QA', build: 'isolated', status: async () => 'live', getEngineError: async () => null,
    onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb) }, onStatus: () => () => {}, onMenuAction: () => () => {},
    setWindowTheme() {}, notifySnapshot() {}, readClipboardSnapshot: async () => ({ text: '', changeCount: 0 }),
    readClipboard: async () => '', loadFileThumbnail: async () => null, loadThumbnail: async () => null,
    request: async op => op === 'list' ? { tasks: all() } : op === 'getSettings' ? { settings: { downloadDirectory: '/qa/Downloads', maxConnections: 8 } } : op === 'completionStack' ? { artifacts: [] } : { ok: true } }
})
const read = () => page.locator('[data-task-select="81722"]').evaluate(row => {
  const visible = []
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode, text = node.textContent.trim()
    if (!text) continue
    const range = document.createRange(); range.selectNodeContents(node)
    const rect = range.getBoundingClientRect()
    if (!rect.width || !rect.height) continue
    let clipped = false
    for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
      const css = getComputedStyle(element), box = element.getBoundingClientRect()
      if (css.visibility === 'hidden') { clipped = true; break }
      if (/(hidden|clip|auto|scroll)/.test(css.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) clipped = true
    }
    const cell = node.parentElement.closest('[data-transfer-metadata]') ? row.firstElementChild.getBoundingClientRect() : null
    if (cell && (rect.left < cell.left - 1 || rect.right > cell.right - 7)) clipped = true
    visible.push({ text, clipped, left: rect.left, right: rect.right, cellRight: cell?.right })
  }
  const metric = row.querySelector('[data-transfer-metadata]')?.getBoundingClientRect()
  const progress = row.closest('[data-stacked-progress]') ? row.querySelector('.task-row-progress')?.getBoundingClientRect() : null
  const verticalOverlap = Boolean(metric?.width && progress?.width && metric.bottom > progress.top + 1 && metric.top < progress.bottom)
  const table = row.closest('.task-table')
  return { verticalOverlap, tableWidth: table.clientWidth, nameWidth: row.firstElementChild.clientWidth, hideTime: table.hasAttribute('data-hide-time'), hideSize: table.hasAttribute('data-hide-size'), visible }
})
try {
  await page.goto('http://fixture.test/')
  await page.locator('[data-task-select="81722"]').waitFor({ timeout: 5000 }).catch(async error => { console.log(JSON.stringify({ errors, body: await page.locator('body').innerText() })); throw error })
  for (const details of [false, true]) {
    if (details) await page.locator('[data-task-select="81722"]').click()
    for (const width of [920, 1024, 1440]) for (const scale of [1, 1.25]) {
      await page.setViewportSize({ width: Math.round(width / scale), height: 820 })
      await page.waitForTimeout(180)
      const state = await read(), context = { width, simulatedScale: scale, details, ...state }
      rows.push(context); console.log(JSON.stringify(context))
      const texts = state.visible.filter(item => !item.clipped).map(item => item.text).join(' ')
      const speedCount = (texts.match(/8\.00 MB\/s/g) || []).length
      const etaCount = (texts.match(/剩余\s*10秒/g) || []).length
      if (state.verticalOverlap) failures.push({ width, scale, details, verticalOverlap: true })
      if (speedCount !== 1 || etaCount !== 1) failures.push({ width, scale, details, speedCount, etaCount })
      if (details && [920, 1024].includes(width)) await page.screenshot({ path: join(output, `${width}-${scale}-details.png`) })
    }
  }
  await page.evaluate(() => __patch({ bytesPerSecond: 80 * 1024 ** 2 / 5400 }))
  for (const width of [736, 819]) {
    await page.setViewportSize({ width, height: 820 }); await page.waitForTimeout(180)
    const longEta = await read()
    rows.push({ longEta: true, width, ...longEta })
    if (longEta.verticalOverlap || !longEta.visible.some(item => !item.clipped && item.text.includes('剩余 1小时30分'))) failures.push({ longEtaClipped: true, width })
  }
  await page.evaluate(() => __patch({ bytesPerSecond: 8 * 1024 ** 2 }))
  await page.waitForTimeout(180)
  await page.setViewportSize({ width: 920, height: 820 })
  if (!(await page.locator('[data-inspector-summary]').innerText()).includes('预计剩余 10秒')) failures.push({ inspectorEtaMissing: true })
  await page.evaluate(() => __patch({ bytesPerSecond: 0 }))
  await page.waitForTimeout(180)
  const unknown = await read()
  if (!(await page.locator('[data-inspector-summary]').innerText()).includes('剩余时间计算中')) failures.push({ inspectorUnknownMissing: true })
  if (!unknown.visible.some(item => !item.clipped && item.text.includes('计算中'))) failures.push({ unknownEtaMissing: true })
  await page.evaluate(() => __patch({ status: 'paused' }))
  await page.waitForTimeout(180)
  const paused = await read()
  if (/剩余|计算中/.test(await page.locator('[data-inspector-summary]').innerText())) failures.push({ inspectorPausedStale: true })
  if (paused.visible.some(item => !item.clipped && /MB\/s|KB\/s|剩余|计算中/.test(item.text))) failures.push({ stalePausedMetrics: true })
  const collectionChecks = []
  await page.evaluate(() => __patch({ status: 'downloading', bytesPerSecond: 8 * 1024 ** 2 }))
  for (const width of [736, 819, 920]) {
    await page.setViewportSize({ width, height: 820 }); await page.waitForTimeout(180)
    const group = page.locator('[data-collection-group="metrics-course"]')
    await group.scrollIntoViewIfNeeded()
    const geometry = await group.evaluate(group => {
      const row = group.querySelector('.task-table-row'), heading = row.querySelector('[data-collection-heading]')
      const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
      const status = heading.querySelector('[aria-live]'), progress = row.querySelector('.task-row-progress')
      return { row: rect(row), heading: rect(heading), status: rect(status), progress: rect(progress) }
    })
    collectionChecks.push({ width, ...geometry })
    if (geometry.row.height > 72.5 || geometry.status.bottom > geometry.progress.top + 1 && geometry.status.left < geometry.progress.right && geometry.status.right > geometry.progress.left)
      failures.push({ collectionOverlap: true, width, geometry })
    await group.getByRole('button', { name: /^展开合集/ }).click()
    await page.locator('[data-task-select="81801"]').waitFor()
    const active = await read()
    if (!active.visible.some(item => !item.clipped && item.text.includes('剩余 10秒'))) failures.push({ collectionExpansionLostMetrics: true, width })
    await group.getByRole('button', { name: /^收起合集/ }).click()
    await page.waitForTimeout(500)
    const settled = await page.evaluate(() => {
      const group = document.querySelector('[data-collection-group="metrics-course"]')
      const task = document.querySelector('[data-task-select="81722"]')
      return { collectionBottom: group.getBoundingClientRect().bottom, taskTop: task.getBoundingClientRect().top, childrenPresent: Boolean(document.querySelector('[data-task-select="81801"]')) }
    })
    collectionChecks[collectionChecks.length - 1].settled = settled
    console.log(JSON.stringify({ collectionSettled: true, width, ...settled }))
    if (width === 736) await page.screenshot({ path: join(output, 'collection-narrow.png') })
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ rows, unknown, paused, collectionChecks, errors, failures }, null, 2))
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [], 'Every active row needs visible, unclipped and nonduplicate speed/ETA')
} finally { await browser.close() }
