// Real Electron main/preload/renderer, private TCP engine and synthetic tasks.
// Build first, then run: node scripts/qa-component-motion.mjs
// Does not download, open external apps, or use the user's clipboard/profile.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'
import { runWorkspaceMotionCases } from './qa-workspace-motion-cases.mjs'
import { runFeedbackMotionCases } from './qa-feedback-motion-cases.mjs'
import { runFileComponentCases } from './qa-file-components-cases.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const packagedExecutable = process.env.NDM_QA_APP_PATH?.trim()
const packagedResources = packagedExecutable ? resolve(packagedExecutable, '../../Resources') : null
const root = mkdtempSync('/tmp/ndm-component-motion-')
const output = resolve(process.env.NDM_COMPONENT_MOTION_QA_OUTPUT || `${root}/artifacts`)
mkdirSync(output, { recursive: true })
mkdirSync(`${root}/engine`, { recursive: true })
const fingerprint = () => packagedResources
  ? Object.fromEntries(['app.asar', 'bin/NDMHost'].map(path => [path, createHash('sha256').update(readFileSync(`${packagedResources}/${path}`)).digest('hex')]))
  : Object.fromEntries([
  'out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html',
  ...readdirSync(`${repository}/out/renderer/assets`).filter(name => /\.(css|js)$/.test(name)).map(name => `out/renderer/assets/${name}`)
].map(path => [path, createHash('sha256').update(readFileSync(`${repository}/${path}`)).digest('hex')]))
const testedBuild = fingerprint()
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
const dirtySource = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/qa-component-motion.mjs'], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const MiB = 1024 ** 2
const now = Date.now()
const makeTasks = count => Array.from({ length: count }, (_, index) => ({
  id: 100 + index, filename: `Motion QA ${String(index).padStart(4, '0')}.zip`, title: `Motion QA ${String(index).padStart(4, '0')}.zip`,
  url: `https://example.invalid/component-motion/${index}.zip`, source: 'example.invalid', folderPath: `${root}/files`,
  category: 'compressed', status: index === 0 ? 'downloading' : 'paused', fileSize: 80 * MiB,
  completedBytes: 20 * MiB, bytesPerSecond: index === 0 ? MiB : 0, connections: 4, segments: [], activityAt: now - index * 1000
}))
let tasks = makeTasks(12)
let draft = { revision: 0, draft: null }
const sockets = new Set(), pending = [], requests = [], errors = [], checks = [], captures = []
const send = (socket, value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`) }
const snapshot = () => { for (const socket of sockets) send(socket, { op: 'snapshot', tasks }) }
const replaceTasks = count => { tasks = makeTasks(count); snapshot() }
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', error => errors.push(`fixture socket: ${error.message}`))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      requests.push({ op: request.op, taskID: request.taskID })
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: `${root}/files`, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, bridgePort: bridge.address().port }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, relayClients: [] }
      if (request.op === 'completionStack') reply.artifacts = []
      if (request.op === 'fileArtwork') reply.artwork = null
      if (request.op === 'temporaryBandwidthStatus') Object.assign(reply, { status: 'inactive', limitBytesPerSecond: null, previousLimitBytesPerSecond: null, expiresAt: null })
      if (request.op === 'composerDraftLoad') Object.assign(reply, draft)
      if (request.op === 'composerDraftSave' || request.op === 'composerDraftDiscard') {
        if (request.expectedRevision !== draft.revision) Object.assign(reply, { ok: false, code: 'conflict', revision: draft.revision })
        else { draft = { revision: draft.revision + 1, draft: request.op === 'composerDraftDiscard' ? null : request.draft }; Object.assign(reply, draft) }
      }
      if (request.op === 'checkStorage') Object.assign(reply, { level: 'comfortable', availableBytes: 100000 * MiB, projectedFreeBytes: 99900 * MiB })
      if (request.op === 'pause' || request.op === 'resume') {
        if (!tasks.some(task => task.id === request.taskID)) send(socket, { ...reply, ok: false, error: 'Unknown fixture task' })
        else pending.push({ socket, request, reply })
        continue
      }
      // A visual interaction test must never create or delete a download.
      if (['add', 'addMedia', 'remove', 'removeMany', 'restart', 'renew'].includes(request.op)) Object.assign(reply, { ok: false, error: 'Outside component-motion QA scope' })
      send(socket, reply)
    }
  })
})
// Reserve a separate bridge port as well. This fixture has no Relay connection.
const bridge = createServer(socket => socket.destroy())
await new Promise(done => bridge.listen(0, '127.0.0.1', done))
await new Promise(done => server.listen(0, '127.0.0.1', done))
const settle = success => {
  const item = pending.shift()
  assert.ok(item, 'A real UI command must reach the fixture before it can finish')
  if (success) {
    const task = tasks.find(task => task.id === item.request.taskID)
    task.status = item.request.op === 'pause' ? 'paused' : 'downloading'
    task.bytesPerSecond = item.request.op === 'pause' ? 0 : 2 * MiB
    send(item.socket, item.reply)
    snapshot()
  } else send(item.socket, { ...item.reply, ok: false, error: '合成测试：连接暂时不可用，请重试。' })
}

let app, win
let passed = false
const waitPending = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pending.length) return
    await win.waitForTimeout(20)
  }
  throw new Error('UI command did not reach the private fixture')
}
const capture = async name => {
  await win.evaluate(() => document.fonts.ready)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  writeFileSync(`${output}/${name}.png`, Buffer.from(png, 'base64'))
  writeFileSync(`${output}/${name}.aria.txt`, await win.locator('body').ariaSnapshot())
  captures.push(name)
}
// Registration completes before the caller sends the gesture/snapshot. The
// evaluate call returns immediately rather than holding an unresolved page
// promise while the test tries to deliver the update it is meant to observe.
let samplerSequence = 0
const startSampler = async (selector, duration = 360, { waitForChange = false } = {}) => {
  const token = `motion-${++samplerSequence}`
  await win.evaluate(({ token, selector, duration, waitForChange }) => {
    const samplers = window.__ndmComponentMotionSamplers ??= {}
    const initial = document.querySelector(selector)
    const state = samplers[token] = {
      selector, startedAt: performance.now(), initialText: initial?.textContent ?? null,
      initialPresent: Boolean(initial), firstChangeAt: null, values: [], done: false, reason: null
    }
    let frameId
    const complete = reason => {
      if (state.done) return
      state.done = true
      state.reason = reason
      cancelAnimationFrame(frameId)
      clearTimeout(limit)
    }
    const limit = setTimeout(() => complete('2000ms-limit'), 2000)
    const frame = () => {
      const at = performance.now() - state.startedAt
      const node = document.querySelector(selector)
      if (node) {
        const box = node.getBoundingClientRect(), css = getComputedStyle(node)
        if (state.firstChangeAt === null && (!state.initialPresent || node.textContent !== state.initialText)) state.firstChangeAt = at
        state.values.push({ at, textContent: node.textContent, opacity: Number(css.opacity), transform: css.transform, translate: css.translate, scale: css.scale, rotate: css.rotate, x: box.x, y: box.y, width: box.width, height: box.height })
      }
      const observedChange = !waitForChange || state.firstChangeAt !== null
      const coveredChange = state.firstChangeAt === null || at - state.firstChangeAt >= 220
      if (at >= duration && observedChange && coveredChange) complete('observed-window')
      else frameId = requestAnimationFrame(frame)
    }
    frameId = requestAnimationFrame(frame)
  }, { token, selector, duration, waitForChange })
  return {
    token,
    finish: async () => {
      await win.waitForFunction(token => window.__ndmComponentMotionSamplers?.[token]?.done, token, { timeout: 4000 })
      const evidence = await win.evaluate(token => {
        const result = window.__ndmComponentMotionSamplers[token]
        delete window.__ndmComponentMotionSamplers[token]
        return result
      }, token)
      writeFileSync(`${output}/sampler-${token}.json`, `${JSON.stringify(evidence, null, 2)}\n`)
      return evidence.values
    }
  }
}
const unmoved = value => {
  const matrix = value.transform === 'none' ? [1, 0, 0, 1, 0, 0] : value.transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number)
  return matrix?.every((number, i) => Math.abs(number - [1, 0, 0, 1, 0, 0][i]) < 0.001) &&
    ['none', '0px', '0px 0px'].includes(value.translate) && ['none', '1', '1 1'].includes(value.scale) && ['none', '0deg'].includes(value.rotate)
}
// The selection button is .task-table-row; its action rail is a sibling inside
// the data-task-state wrapper, not a descendant of that button.
const row = id => win.locator('[data-task-state]').filter({ has: win.locator(`[data-task-select="${id}"]`) })
const primary = id => row(id).locator('[data-task-primary-action]')
const batch = () => win.getByRole('toolbar', { name: '批量任务操作', exact: true })
const composer = () => win.getByRole('dialog', { name: '添加下载', exact: true })
const waitCount = value => win.waitForFunction(value => document.querySelector('#workspace-result-count [data-count-current]')?.textContent === String(value), value)
const verifyCount = async value => {
  await waitCount(value)
  const result = await win.locator('#workspace-result-count').evaluate(element => {
    const counter = element.querySelector('[data-animated-count]')
    return { slots: [...counter.children].map(node => ({ value: node.textContent, hidden: node.getAttribute('aria-hidden'), live: node.getAttribute('aria-live') })), text: element.textContent }
  })
  assert.deepEqual(result.slots.filter(slot => slot.hidden !== 'true').map(slot => slot.value), [String(value)], 'Only the current number may be exposed to assistive technology')
  assert.ok(result.slots.every(slot => !slot.live), 'Animated digits must not create duplicate live regions')
  return result
}

try {
  const env = { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_BRIDGE_PORT: String(bridge.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_DISABLE_LEGACY_BRIDGE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable, args: [`--user-data-dir=${root}/electron`] }
      : { args: ['.', `--user-data-dir=${root}/electron`] }),
    cwd: repository, env
  })
  win = await app.firstWindow()
  win.on('pageerror', error => errors.push(error.message))
  win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await win.waitForLoadState('domcontentloaded')
  // Normal-motion assertions must not inherit the user's macOS preference.
  // The reduced-motion section below changes this same live page explicitly.
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await win.waitForFunction(() => matchMedia('(prefers-reduced-motion: no-preference)').matches)
  // Install these before onboarding enables clipboard offers.
  await app.evaluate(({ ipcMain }) => {
    const handlers = {
      'system:read-clipboard': () => '',
      'system:clipboard-snapshot': () => ({ text: '', changeCount: 0, selfWritten: false }),
      'system:write-clipboard': () => true,
      'system:open-path': () => '', 'system:reveal-file': () => true,
      'system:quick-look': () => true, 'system:open-external': () => true,
      'system:classify-url': () => ({ kind: 'binary', contentType: 'application/octet-stream' })
    }
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  })
  await completeOnboarding(win)
  // Existing row cases exercise the list; the gallery has its own cases below.
  await win.getByRole('button', { name: '列表视图', exact: true }).click()
  await primary(101).waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))

  await primary(101).click()
  await waitPending()
  assert.equal(tasks.find(task => task.id === 101).status, 'paused')
  assert.equal(await primary(101).getAttribute('aria-busy'), 'true')
  assert.equal(await primary(101).isDisabled(), true)
  assert.equal(await primary(101).locator('[data-transfer-action-icon]').getAttribute('data-transfer-action-icon'), 'pending')
  assert.equal(await primary(101).locator('[data-transfer-action-icon]').getAttribute('aria-hidden'), 'true', 'Decorative icon layers cannot duplicate the button name')
  await capture('01-resume-awaiting-receipt')
  settle(false)
  await win.waitForFunction(() => {
    const action = document.querySelector('[data-task-select="101"]')?.closest('[data-task-state]')?.querySelector('[data-task-primary-action]')
    return Boolean(action) && action.getAttribute('aria-busy') !== 'true'
  })
  assert.equal(tasks.find(task => task.id === 101).status, 'paused', 'A rejected command cannot become successful')
  assert.equal(await primary(101).isEnabled(), true)
  assert.equal(await primary(101).locator('[data-transfer-action-icon]').getAttribute('data-transfer-action-icon'), 'play')
  assert.ok(await primary(101).getAttribute('aria-describedby'), 'Command failure remains associated with its control')
  await primary(101).click()
  await waitPending()
  settle(true)
  await primary(101).filter({ hasText: '暂停' }).waitFor()
  assert.equal(await primary(101).locator('[data-transfer-action-icon]').getAttribute('data-transfer-action-icon'), 'pause')
  await primary(101).click()
  await waitPending()
  assert.equal(tasks.find(task => task.id === 101).status, 'downloading')
  settle(true)
  await primary(101).filter({ hasText: '继续' }).waitFor()
  checks.push({ name: 'Transfer action waits for receipt, shows failure, retries and pauses', passed: true })

  const counterFrames = await startSampler('#workspace-result-count [data-count-current]', 360, { waitForChange: true })
  for (const value of [9, 10, 11, 9]) { replaceTasks(value); await waitCount(value); await win.waitForTimeout(45) }
  const countTrace = await counterFrames.finish()
  await win.waitForTimeout(220)
  const countDebug = await win.evaluate(() => ({
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
    visibilityState: document.visibilityState,
    slots: [...document.querySelectorAll('#workspace-result-count [data-animated-count] > *')].map(node => {
      const css = getComputedStyle(node)
      return { value: node.textContent, hidden: node.getAttribute('aria-hidden'), live: node.getAttribute('aria-live'), current: node.hasAttribute('data-count-current'), outgoing: node.hasAttribute('data-count-outgoing'), opacity: css.opacity, transform: css.transform, translate: css.translate }
    })
  }))
  writeFileSync(`${output}/count-debug.json`, `${JSON.stringify({ countTrace, ...countDebug }, null, 2)}\n`)
  const countEvidence = await verifyCount(9)
  checks.push({ name: 'Rapid count changes settle on the latest exact accessible value', passed: true, countEvidence, frames: countTrace })
  replaceTasks(12)
  await waitCount(12)

  for (const theme of ['dawn', 'walnut']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 680))
    await win.waitForTimeout(220)
    const before = await win.locator('.task-table').boundingBox()
    await win.locator('[data-task-select="101"]').click()
    // A single selection opens the narrow-window inspector overlay. Dismiss it
    // through its existing control before extending the selection underneath.
    await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    await win.locator('[data-task-select="102"]').click({ modifiers: ['Meta'] })
    await batch().waitFor()
    await batch().getByRole('button', { name: '取消选择', exact: true }).focus()
    await capture(`02-batch-${theme}-740`)
    const during = await win.locator('.task-table').boundingBox()
    assert.ok(Math.abs(before.y - during.y) <= 1, 'Batch toolbar must keep the task list at the same vertical position')
    await batch().getByRole('button', { name: '取消选择', exact: true }).click()
    await batch().waitFor({ state: 'hidden' })
    const departingLayer = await win.locator('[data-context-visible="false"]').evaluateAll(nodes => nodes.map(node => ({ inert: node.inert || Boolean(node.closest('[inert]')), hidden: node.getAttribute('aria-hidden') === 'true' || Boolean(node.closest('[aria-hidden="true"]')) })))
    assert.ok(departingLayer.every(node => node.inert && node.hidden), 'Any retained departing selection layer must immediately leave focus and accessibility navigation')
    await win.waitForTimeout(220)
    const after = await win.locator('.task-table').boundingBox()
    assert.ok(Math.abs(before.y - after.y) <= 1, 'Closing the batch toolbar must not shift the task list')
    const focus = await win.evaluate(() => ({ connected: Boolean(document.activeElement?.isConnected), body: document.activeElement === document.body, hiddenLayer: Boolean(document.activeElement?.closest('[data-context-visible="false"]')) }))
    assert.ok(focus.connected && !focus.body && !focus.hiddenLayer, 'Focus cannot be stranded in the departing selection toolbar')
    await win.getByRole('searchbox', { name: '搜索下载任务' }).click()
    assert.equal(await win.getByRole('searchbox', { name: '搜索下载任务' }).evaluate(node => node === document.activeElement), true, 'Departed layer must not intercept clicks')

    await win.getByRole('button', { name: '切换侧栏', exact: true }).click()
    const trigger = win.getByRole('button', { name: '添加下载', exact: true }).first()
    await trigger.focus()
    const enterFrames = await startSampler('.ndm-composer', 360, { waitForChange: true })
    await win.keyboard.press('Enter')
    await composer().waitFor()
    await win.getByRole('textbox', { name: '下载链接', exact: true }).waitFor()
    const entered = await enterFrames.finish()
    assert.ok(entered.some(frame => frame.opacity > 0 && frame.opacity < 1), 'Composer entrance must have a visible intermediate frame')
    const heights = await startSampler('.ndm-composer [data-animated-height]', 440, { waitForChange: true })
    await composer().getByRole('button', { name: '选项', exact: true }).click()
    const heightTrace = await heights.finish()
    await composer().getByRole('textbox', { name: '重命名', exact: true }).scrollIntoViewIfNeeded()
    const geometry = await composer().evaluate(element => {
      const rect = node => node.getBoundingClientRect().toJSON()
      const scroll = element.querySelector('.composer-scroll-body')
      return { dialog: rect(element), submit: rect(element.querySelector('button[type="submit"]')), viewport: { width: innerWidth, height: innerHeight }, overflow: scroll.scrollWidth - scroll.clientWidth }
    })
    assert.ok(geometry.dialog.x >= -1 && geometry.dialog.right <= geometry.viewport.width + 1)
    assert.ok(geometry.dialog.y >= -1 && geometry.dialog.bottom <= geometry.viewport.height + 1)
    assert.ok(geometry.submit.bottom <= geometry.viewport.height + 1 && geometry.submit.y >= 0, 'Advanced options cannot clip the submit button')
    assert.ok(geometry.overflow <= 1, 'Composer scroll body must not overflow horizontally')
    assert.ok(heightTrace.length && new Set(heightTrace.map(frame => Math.round(frame.height))).size > 2, 'Advanced options must animate actual content height')
    for (let index = 0; index < 10; index++) {
      await win.keyboard.press(index < 5 ? 'Tab' : 'Shift+Tab')
      assert.equal(await win.evaluate(() => Boolean(document.activeElement?.closest('.ndm-composer'))), true, 'Composer must retain keyboard focus')
    }
    await capture(`03-composer-${theme}-740-options`)
    await win.keyboard.press('Escape')
    await composer().waitFor({ state: 'hidden' })
    await win.waitForFunction(() => !document.activeElement?.closest('.ndm-composer'))
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape must restore the opening control')
    // Reopen while exit is still in flight, then close once more.
    await trigger.focus(); await win.keyboard.press('Enter'); await composer().waitFor()
    await win.keyboard.press('Escape'); await win.waitForTimeout(45); await win.keyboard.press('Meta+n')
    await composer().waitFor()
    assert.equal(await composer().count(), 1, 'Rapid reversal cannot duplicate dialogs')
    await composer().getByRole('textbox', { name: '下载链接', exact: true }).click()
    await win.keyboard.press('Escape'); await composer().waitFor({ state: 'hidden' })
    await win.waitForTimeout(220)
    await trigger.click(); await composer().waitFor(); await win.keyboard.press('Escape'); await composer().waitFor({ state: 'hidden' })
    await win.getByRole('button', { name: '收起侧栏', exact: true }).click()
    checks.push({ name: `${theme}: narrow batch geometry, Composer height and keyboard/reversal`, passed: true, geometry, heightTrace, enterFrames: entered })
  }

  await runWorkspaceMotionCases({ app, win, startSampler, capture, checks })
  await runFeedbackMotionCases({ app, win, startSampler, capture, checks })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 680))
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await win.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  replaceTasks(12); await waitCount(12)
  const reducedCountFrames = await startSampler('#workspace-result-count [data-count-current]', 360, { waitForChange: true })
  replaceTasks(10); await waitCount(10)
  const reducedCounts = await reducedCountFrames.finish()
  assert.ok(reducedCounts.length && reducedCounts.every(unmoved), 'Reduced-motion count must not translate or scale')
  await verifyCount(10)
  await primary(101).click(); await waitPending()
  const iconSelector = '[data-task-state]:has([data-task-select="101"]) [data-transfer-action-icon="pending"] svg'
  const reducedIconSampler = await startSampler(iconSelector)
  const reducedIconFrames = await reducedIconSampler.finish()
  assert.ok(reducedIconFrames.length && reducedIconFrames.every(unmoved), 'Pending icon must not spin under reduced motion')
  settle(true)
  await primary(101).filter({ hasText: '暂停' }).waitFor()
  await win.getByRole('button', { name: '切换侧栏', exact: true }).click()
  const reducedComposerFrames = await startSampler('.ndm-composer', 360, { waitForChange: true })
  await win.getByRole('button', { name: '添加下载', exact: true }).first().click()
  await composer().waitFor()
  const reducedComposer = await reducedComposerFrames.finish()
  assert.ok(reducedComposer.length && reducedComposer.every(unmoved), 'Reduced-motion Composer must not translate or scale')
  await capture('04-reduced-motion-composer')
  await win.keyboard.press('Escape'); await composer().waitFor({ state: 'hidden' })
  await win.getByRole('button', { name: '收起侧栏', exact: true }).click()
  checks.push({ name: 'Reduced motion preserves content without count movement, icon rotation or Composer transform', passed: true, reducedCounts, reducedIconFrames, reducedComposer })

  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  replaceTasks(2000)
  await waitCount(2000)
  await win.waitForTimeout(250)
  assert.ok(await win.locator('[data-task-select]').count() < 80, 'A large library must remain virtualized')
  await verifyCount(2000)
  await win.locator('.task-table section').evaluate(node => { node.scrollTop = node.scrollHeight })
  await win.locator('[data-task-select="2099"]').waitFor()
  const list = await win.locator('.task-table').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, rows: node.querySelectorAll('[data-task-select]').length }))
  assert.ok(list.scrollWidth <= list.width + 1, 'Large counts must not force horizontal overflow')
  await capture('05-large-library-last-row')
  checks.push({ name: '2000 synthetic tasks retain exact count, bounded mounted rows and last-row access', passed: true, list })
  await runFileComponentCases({ app, win, capture, checks, startSampler, getTasks: () => tasks,
    setTasks: next => { tasks = next; snapshot() }, waitCount, waitPending, settle })
  assert.ok(countTrace.some(frame => frame.opacity > 0 && frame.opacity < 1), 'Normal count transition must have an intermediate visible frame')
  assert.deepEqual(requests.filter(item => ['add', 'addMedia', 'remove', 'removeMany', 'restart', 'renew'].includes(item.op)), [], 'No real creation/deletion command belongs in this visual QA')
  assert.equal(pending.length, 0)
  assert.deepEqual(errors, [], 'No renderer or fixture errors')
  assert.deepEqual(fingerprint(), testedBuild, 'Build must remain unchanged throughout QA')
  passed = true
} catch (error) {
  errors.push(error.stack || String(error))
  if (win) await capture('failure').catch(() => {})
  process.exitCode = 1
} finally {
  for (const item of pending.splice(0)) send(item.socket, { ...item.reply, ok: false, error: 'QA closing' })
  try { await app?.close() } catch (error) { passed = false; errors.push(`Electron cleanup: ${error.message}`); process.exitCode = 1 }
  for (const socket of sockets) socket.destroy()
  await new Promise(done => server.close(done))
  await new Promise(done => bridge.close(done))
  const report = { passed, commit, dirtySource, root, output, packagedExecutable: packagedExecutable ?? null, testedBuild, boundary: 'Real Electron main/preload/renderer; private TCP fixture, synthetic tasks and independent userData/support/host/bridge ports. No native download or real file/clipboard action tested.', checks, captures, requests, errors, cleanup: { hostFixtureListening: server.listening, bridgeFixtureListening: bridge.listening, remainingSockets: sockets.size } }
  writeFileSync(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed, output, checks: checks.length, captures: captures.length, errors }))
}
