import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

// Start scripts/qa-renderer-preview.mjs separately. This exercises the actual
// React renderer through Chrome; only the fixture's engine replies are mocked.
const output = resolve(process.env.NDM_COMPOSER_QA_OUTPUT || 'output/playwright/composer-pr4')
const base = process.env.NDM_COMPOSER_QA_URL || 'http://127.0.0.1:53841'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), browser: browser.version(), boundary: 'Real Chrome and production React/CSS, isolated browser contexts, mock fixture engine. No native decoding, real download, clipboard, user browser profile, or native traffic lights tested here.', scenarios: [] }

async function geometry(page) {
  return page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    const dialog = document.querySelector('[role="dialog"]')
    const scroll = document.querySelector('.composer-scroll-body')
    const grid = document.querySelector('.composer-quality-grid')
    const container = document.querySelector('.composer-container-control')
    const subtitle = document.querySelector('.composer-subtitle-control')
    const submit = dialog.querySelector('button[type="submit"]')
    return {
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      dialog: rect(dialog), body: { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight },
      grid: grid ? { ...rect(grid), columns: getComputedStyle(grid).gridTemplateColumns, clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth } : null,
      container: container ? rect(container) : null, subtitle: subtitle ? { ...rect(subtitle), disabled: subtitle.disabled, hasArrow: Boolean(subtitle.parentElement.querySelector('svg')) } : null,
      submit: rect(submit), controls: [...dialog.querySelectorAll('button,input,select')].map(el => ({ name: el.getAttribute('aria-label') || el.textContent?.trim(), ...rect(el) }))
    }
  })
}

function assertGeometry(g, theme) {
  assert.equal(g.theme, theme)
  assert(g.dialog.x >= -1 && g.dialog.right <= g.viewport.width + 1, 'dialog fits width')
  assert(g.dialog.y >= -1 && g.dialog.bottom <= g.viewport.height + 1, 'dialog fits height')
  assert(g.body.scrollWidth <= g.body.clientWidth + 1, 'body has no horizontal overflow')
  assert(g.grid.scrollWidth <= g.grid.clientWidth + 1, 'quality grid has no horizontal overflow')
  assert(Math.abs(g.container.height - g.subtitle.height) <= 1, 'format and subtitle controls align in height')
  assert(g.submit.y >= 0 && g.submit.bottom <= g.viewport.height + 1, 'submit is visible')
  for (const control of g.controls) assert(control.x >= g.dialog.x - 1 && control.right <= g.dialog.right + 1, `control fits dialog: ${control.name}`)
}

async function scenario({ name, theme, viewport, subtitles = 'available', probe = 'success', container = 'compactMKV' }) {
  const result = { name, theme, viewport, subtitles, probe, container, checks: [] }
  report.scenarios.push(result)
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  const responses = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push({ text: message.text(), location: message.location() }) })
  page.on('response', response => { if (response.status() >= 400) responses.push({ status: response.status(), url: response.url() }) })
  await page.addInitScript(() => {
    window.__composerQALog = null
    addEventListener('message', event => {
      if (event.source === window && event.origin === location.origin && event.data?.type === 'ndm-qa-log') window.__composerQALog = event.data.state
    })
  })
  const shot = async suffix => {
    const file = `${name}-${suffix}.png`
    await page.screenshot({ path: `${output}/${file}` })
    return file
  }
  try {
    const query = new URLSearchParams({ theme, subtitles, probe, formats: 'extended', traffic: '0', tasks: 'empty' })
    await page.goto(`${base}/scripts/fixtures/renderer-preview/app.html?${query}`)
    const dialog = page.getByRole('dialog', { name: '添加下载' })
    await dialog.waitFor()
    if (probe === 'recover') {
      await dialog.getByRole('button', { name: '重试解析', exact: true }).waitFor()
      assert(await dialog.getByRole('button', { name: '开始下载', exact: true }).isDisabled(), 'unresolved media cannot submit')
      result.errorScreenshot = await shot('probe-failed')
      assert.equal((await page.evaluate(() => window.__composerQALog)).creations.length, 0)
      await dialog.getByRole('button', { name: '重试解析', exact: true }).click()
      result.checks.push('failed probe blocks submit; normal retry button recovers')
    }
    const grid = dialog.getByRole('group', { name: '选择清晰度', exact: true })
    await grid.waitFor()
    await page.waitForFunction(() => window.__composerQALog?.storage.length > 0)
    await page.evaluate(() => document.fonts.ready)
    result.fonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'loaded').map(font => ({ family: font.family, status: font.status })))
    assert.equal(await grid.getByRole('button').count(), 6)
    result.initialGeometry = await geometry(page)
    assertGeometry(result.initialGeometry, theme)
    const subtitle = dialog.getByRole('combobox', { name: '字幕', exact: true })
    assert.equal(await subtitle.isDisabled(), subtitles === 'none')
    assert.equal(result.initialGeometry.subtitle.hasArrow, subtitles !== 'none')
    assert.equal(await subtitle.locator('option').count(), subtitles === 'none' ? 1 : 4)
    result.initialScreenshot = await shot('initial')
    await writeFile(`${output}/${name}-initial-aria.txt`, await page.locator('body').ariaSnapshot())
    result.checks.push('initial list has six formats; subtitle enabled/disabled and arrow match availability; equal 36px controls')

    await dialog.getByRole('button', { name: '全部清晰度 · 10 种', exact: true }).click()
    assert.equal(await grid.getByRole('button').count(), 10)
    const ninth = grid.getByRole('button').nth(8)
    assert.match(await ninth.innerText(), /^144p/)
    await ninth.click()
    assert.equal(await ninth.getAttribute('aria-pressed'), 'true')
    await ninth.scrollIntoViewIfNeeded()
    result.expandedScreenshot = await shot('expanded-ninth-selected')
    await dialog.getByRole('button', { name: '收起清晰度', exact: true }).click()
    assert.equal(await grid.getByRole('button').count(), 6)
    const retained = grid.getByRole('button', { name: /^144p / })
    assert.equal(await retained.getAttribute('aria-pressed'), 'true')
    assert.equal(await grid.locator('button[aria-pressed="true"]').count(), 1)
    result.checks.push('expand exposes all ten options; ninth option 144p stays selected and visible among six after collapse')

    const delivery = dialog.getByRole('group', { name: '成品格式', exact: true })
    await delivery.getByRole('button', { name: 'MKV', exact: true }).click()
    await dialog.getByText('优先保留高效编码，体积通常更小', { exact: true }).waitFor()
    await page.waitForFunction(() => window.__composerQALog?.storage.at(-1)?.container === 'compactMKV')
    assert.match(await retained.innerText(), /16\.0 MB/)
    await delivery.getByRole('button', { name: 'MP4', exact: true }).click()
    await dialog.getByText('兼容优先，便于播放与分享', { exact: true }).waitFor()
    await page.waitForFunction(() => window.__composerQALog?.storage.at(-1)?.container === 'compatibleMP4')
    assert.match(await retained.innerText(), /20\.0 MB/)
    if (container === 'compactMKV') await delivery.getByRole('button', { name: 'MKV', exact: true }).click()
    if (subtitles === 'available') await subtitle.selectOption('zh-Hans')
    result.checks.push('MP4/MKV controls update hint and estimated bytes; subtitle selection uses normal control')
    result.finalGeometry = await geometry(page)
    assertGeometry(result.finalGeometry, theme)
    await retained.scrollIntoViewIfNeeded()
    result.collapsedScreenshot = await shot('collapsed-selection')
    await dialog.locator('#composer-container-hint').scrollIntoViewIfNeeded()
    result.deliveryScreenshot = await shot('delivery-controls')
    await writeFile(`${output}/${name}-final-aria.txt`, await page.locator('body').ariaSnapshot())
    await dialog.getByRole('button', { name: '开始下载', exact: true }).click()
    await page.waitForFunction(() => window.__composerQALog?.creations.length === 1)
    result.log = await page.evaluate(() => window.__composerQALog)
    const creation = result.log.creations[0]
    assert.equal(creation.op, 'addMedia')
    assert.equal(creation.options.formatID, '144')
    assert.equal(creation.options.container, container)
    assert.equal(creation.options.subtitleLanguage, subtitles === 'available' ? 'zh-Hans' : undefined)
    assert.equal(creation.options.collectionScope, 'current')
    assert.equal(creation.options.connections, 16)
    assert.match(creation.options.filename, container === 'compactMKV' ? /\.mkv$/ : /\.mp4$/)
    await dialog.waitFor({ state: 'hidden' })
    result.submittedScreenshot = await shot('submitted')
    result.checks.push('normal submit emits exactly one addMedia with ninth format, selected container/subtitle, current scope and correct filename extension; dialog closes')
    assert.equal(result.log.probes.length, probe === 'recover' ? 2 : 1)
    assert.deepEqual(result.log.unsupported, [])
    assert.deepEqual(errors, [])
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack
    result.failureScreenshot = await shot('failure').catch(() => null)
    result.log = await page.evaluate(() => window.__composerQALog).catch(() => null)
  } finally {
    result.errors = errors
    result.failedResponses = responses
    await context.close()
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ name, status: result.status, error: result.error }))
  }
}

try {
  for (const theme of ['dawn', 'walnut']) {
    await scenario({ name: `${theme}-wide`, theme, viewport: { width: 1280, height: 900 } })
    await scenario({ name: `${theme}-narrow`, theme, viewport: { width: 720, height: 600 } })
  }
  await scenario({ name: 'dawn-no-subtitles', theme: 'dawn', viewport: { width: 960, height: 700 }, subtitles: 'none', container: 'compatibleMP4' })
  await scenario({ name: 'walnut-retry', theme: 'walnut', viewport: { width: 720, height: 600 }, probe: 'recover' })
} finally {
  await browser.close()
  report.finishedAt = new Date().toISOString()
  report.passed = report.scenarios.filter(scenario => scenario.status === 'passed').length
  report.failed = report.scenarios.filter(scenario => scenario.status !== 'passed').length
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
}
if (report.failed) process.exitCode = 1
