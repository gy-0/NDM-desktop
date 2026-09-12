// Focused Inspector scheduling QA. Real Electron main/preload/renderer, private
// TCP fixture host and synthetic tasks. This checks UI/RPC, not engine timers.
// --before captures an independently preserved pre-change out/ build via
// NDM_QA_SCHEDULING_APP_ROOT. Never build over a running QA bundle.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { completeOnboarding, openDownloadSettings } from './qa-env.mjs'

const before = process.argv.includes('--before')
const pauseClearsAppointment = process.env.NDM_QA_SCHEDULE_PAUSE_BEHAVIOR !== 'keep'
const phase = before ? 'before' : pauseClearsAppointment ? 'after' : 'after-windows-pause'
const repository = fileURLToPath(new URL('..', import.meta.url))
const appRoot = process.env.NDM_QA_SCHEDULING_APP_ROOT || repository
const root = mkdtempSync('/tmp/ndm-secondary-scheduling-')
const output = resolve(repository, 'docs/design/assets/2026-09-12-secondary-scheduling', phase)
mkdirSync(output, { recursive: true })
const commit = execFileSync('git', ['rev-parse', process.env.NDM_QA_SCHEDULING_SOURCE_COMMIT || 'HEAD'], { encoding: 'utf8', cwd: repository }).trim()
const dirtySource = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/qa-secondary-scheduling.mjs'], { encoding: 'utf8', cwd: repository }).trim().split('\n').filter(Boolean)
const fingerprint = () => Object.fromEntries(['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html', ...readdirSync(`${appRoot}/out/renderer/assets`).filter(name => /\.(js|css)$/.test(name)).map(name => `out/renderer/assets/${name}`)].map(path => [path, createHash('sha256').update(readFileSync(`${appRoot}/${path}`)).digest('hex')]))
const testedBuild = fingerprint()
const scheduledAt = new Date(); scheduledAt.setDate(scheduledAt.getDate() + 2); scheduledAt.setHours(20, 30, 0, 0)
const tasks = [
  { id: 1, filename: '设计手册 · 等待继续.pdf', status: 'paused', fileSize: 32 * 1024 ** 2, completedBytes: 12 * 1024 ** 2 },
  { id: 2, filename: '素材归档 · 已有预约.zip', category: 'compressed', status: 'waiting', startAt: scheduledAt.getTime(), fileSize: 240 * 1024 ** 2, completedBytes: 0 }
].map((task, index) => ({ category: 'document', title: task.filename, url: `https://example.com/scheduling/${task.id}`, source: 'example.com', folderPath: `${root}/files`, bytesPerSecond: 0, connections: 4, segments: [], activityAt: Date.now() - index * 3600000, ...task }))
const sockets = new Set(), timers = new Set(), requests = [], evidence = [], checks = [], errors = [], heldReplies = []
let rejectNextOp = null
let holdOp = null
let deferredPauseSnapshot = false
const send = (socket, body) => { if (!socket.destroyed) socket.write(JSON.stringify(body) + '\n') }
const snapshot = () => { for (const socket of sockets) send(socket, { op: 'snapshot', tasks }) }
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push({ op: request.op, taskID: request.taskID, startAt: request.startAt })
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: `${root}/files`, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, relayClients: [] }
      if (['schedule', 'resume', 'pause'].includes(request.op)) {
        const task = tasks.find(task => task.id === request.taskID)
        assert.ok(task, 'Only synthetic tasks may be changed')
        const rejected = request.op === rejectNextOp
        if (rejected) rejectNextOp = null
        const complete = () => {
          if (rejected) {
            send(socket, { ...reply, ok: false, error: 'Synthetic scheduling rejection' })
            if (deferredPauseSnapshot) {
              deferredPauseSnapshot = false
              const deferred = setTimeout(() => { timers.delete(deferred); snapshot() }, 120)
              timers.add(deferred)
            }
          }
          else {
            if (request.op === 'pause') { task.status = 'paused'; if (pauseClearsAppointment) task.startAt = null }
            else if (request.op === 'resume') { task.startAt = null; task.status = 'downloading' }
            else { task.startAt = request.startAt; task.status = request.startAt ? 'waiting' : task.status === 'paused' ? 'paused' : 'waiting' }
            send(socket, reply)
            // A Mac pause clears the appointment before the explicit clear RPC.
            // Delay that snapshot until after a rejected clear to exercise error
            // state against a late authoritative update from the actual engine.
            if (pauseClearsAppointment && request.op === 'pause' && rejectNextOp === 'schedule') deferredPauseSnapshot = true
            else snapshot()
          }
        }
        if (request.op === holdOp) heldReplies.push(complete)
        else { const timer = setTimeout(() => { timers.delete(timer); complete() }, 650); timers.add(timer) }
      } else send(socket, reply)
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
try {
  const env = { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${root}/electron`], cwd: appRoot, env })
  const win = await app.firstWindow()
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  // Fresh onboarding suppresses automatic clipboard polling until replacement.
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, value] of Object.entries({ 'system:read-clipboard': '', 'system:clipboard-snapshot': { text: '', changeCount: 0 }, 'system:write-clipboard': true })) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, () => value)
    }
  })
  await completeOnboarding(win)
  await win.locator('[data-task-select="1"]').waitFor()
  const inspector = win.locator('#task-inspector')
  const group = inspector.getByRole('group', { name: '定时开始', exact: true })
  const setSize = async (width, zoom = 1) => {
    await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 820); window.webContents.setZoomFactor(zoom) }, { width, zoom })
    await win.waitForTimeout(220)
  }
  const select = async (id, { settings = id === 1 } = {}) => {
    await win.locator(`[data-task-select="${id}"]`).click()
    await inspector.waitFor()
    if (before || settings) await openDownloadSettings(win)
    else {
      const summary = inspector.locator('summary').getByText('下载设置', { exact: true })
      if (await summary.evaluate(el => el.parentElement.open)) await summary.click()
    }
    await group.scrollIntoViewIfNeeded()
  }
  const capture = async name => {
    await win.mouse.move(8, 8); await win.waitForTimeout(150)
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(`${output}/${name}.png`, Buffer.from(png, 'base64'))
    evidence.push({ name, inspector: await inspector.count() ? await inspector.innerText() : null, layout: await group.count() ? await group.evaluate(el => ({ viewport: { width: innerWidth, height: innerHeight }, group: el.getBoundingClientRect().toJSON(), startAt: el.getAttribute('data-task-start-at'), inputs: [...el.querySelectorAll('input')].map(input => ({ label: input.getAttribute('aria-label'), value: input.value })), buttons: [...el.querySelectorAll('button')].map(button => ({ label: button.textContent?.trim(), rect: button.getBoundingClientRect().toJSON() })) })) : null })
  }
  await setSize(1220)
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  await select(1); await capture('unplanned-settings-1220')
  await select(2); await capture('scheduled-settings-1220')
  const mutations = () => requests.filter(request => ['schedule', 'resume', 'pause', 'restart', 'pauseAll', 'resumeAll', 'resumeMany', 'pauseMany', 'pauseCollection', 'resumeCollection', 'remove', 'removeMany', 'restartMany', 'add', 'addMedia'].includes(request.op))
  if (!before) {
    const editor = group.locator('[data-schedule-editor]')
    const date = group.getByRole('textbox', { name: '预约日期，日月年', exact: true })
    const time = group.getByRole('textbox', { name: '预约时间，时和分', exact: true })
    const save = () => group.getByRole('button', { name: /^(预约|保存修改)$/ })
    const format = value => { const d = new Date(value); return { date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` } }
    const fill = async value => { const values = format(value); await date.fill(values.date); await time.fill(values.time) }
    const waitForAppointment = value => win.waitForFunction(value => document.querySelector('[data-task-start-at]')?.getAttribute('data-task-start-at') === String(value ?? ''), value)
    const waitForIdle = () => win.waitForFunction(() => document.querySelector('[data-task-start-at]')?.getAttribute('aria-busy') === 'false')
    const waitForHeldReply = async () => {
      const deadline = Date.now() + 10000
      while (!heldReplies.length) { if (Date.now() > deadline) throw new Error('Expected held RPC was not reached'); await win.waitForTimeout(30) }
    }
    const releaseHeldReplies = () => { holdOp = null; for (const reply of heldReplies.splice(0)) reply() }
    const waitForError = () => win.waitForFunction(() => {
      const message = document.querySelector('#task-schedule-status')?.textContent?.trim() || ''
      return document.querySelector('[data-task-start-at]')?.getAttribute('aria-busy') === 'false' && message.length > 0 && !message.startsWith('正在')
    })
    const assertVisibleControls = async label => {
      const geometry = await group.evaluate(el => ({ group: el.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight }, controls: [...el.querySelectorAll('button,input')].filter(control => getComputedStyle(control).display !== 'none').map(control => ({ label: control.getAttribute('aria-label') || control.textContent?.trim(), ...control.getBoundingClientRect().toJSON() })) }))
      for (const control of geometry.controls) assert.ok(control.x >= geometry.group.x - 1 && control.right <= geometry.group.right + 1 && control.x >= 0 && control.right <= geometry.viewport.width + 1, `${label}: ${control.label} remains inside the Inspector`)
      checks.push(label)
    }
    await select(1)
    assert.equal(await editor.count(), 0)
    const entry = group.getByRole('button', { name: '稍后开始', exact: true })
    assert.equal(await entry.getAttribute('aria-expanded'), 'false')
    assert.equal(await group.locator('button').count(), 1)
    assert.equal(await inspector.getByRole('button', { name: /1 小时后|今晚/ }).count(), 0)
    const reverseStart = mutations().length
    rejectNextOp = 'resume'; holdOp = 'resume'
    await win.locator('[data-task-state]').filter({ has: win.locator('[data-task-select="1"]') }).locator('[data-task-primary-action]').click()
    await waitForHeldReply()
    assert.equal(await entry.isDisabled(), true, 'A pending ordinary action prevents a new appointment transaction')
    assert.deepEqual(mutations().slice(reverseStart).map(request => request.op), ['resume'])
    releaseHeldReplies()
    await win.locator('#task-action-status').waitFor()
    await win.getByRole('button', { name: '关闭任务操作提示', exact: true }).click()
    await win.waitForFunction(() => !document.querySelector('[data-task-start-at] button')?.disabled)
    checks.push('reverse lock blocks appointment entry during a pending row operation and releases after rejection')
    const unchanged = mutations().length
    await entry.click()
    await editor.waitFor()
    assert.equal(await date.evaluate(el => el === document.activeElement), true)
    assert.equal(await entry.getAttribute('aria-expanded'), 'true')
    await capture('unplanned-editor-1220')
    await group.getByRole('button', { name: '取消编辑', exact: true }).scrollIntoViewIfNeeded()
    await capture('unplanned-editor-scrolled-1220')
    await group.getByRole('button', { name: '取消编辑', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-controls') === 'task-schedule-editor')
    assert.equal(mutations().length, unchanged)
    checks.push('unplanned task exposes one secondary entry; opening and cancelling edit sends no RPC')

    await entry.click()
    await date.fill('31/02/2026'); await time.fill('25:00'); await save().click()
    await win.waitForFunction(() => document.querySelector('#task-schedule-status')?.textContent?.includes('未来日期'))
    assert.equal(await group.evaluate(el => el.closest('details') !== null), true, 'Invalid input feedback remains in the original settings section')
    assert.equal(await date.getAttribute('aria-invalid'), 'true')
    assert.equal(await time.getAttribute('aria-invalid'), 'true')
    assert.equal(mutations().length, unchanged)
    checks.push('invalid appointment is explained without changing scheduling data')
    const customAt = scheduledAt.getTime() + 24 * 60 * 60 * 1000
    await fill(customAt)
    rejectNextOp = 'schedule'
    const beforeSaveRequests = mutations().length
    await save().click()
    await win.waitForFunction(() => document.querySelector('[data-task-start-at]')?.getAttribute('aria-busy') === 'true')
    assert.equal(await save().isDisabled(), true)
    assert.equal(await group.evaluate(el => el.closest('details') !== null), true, 'Saving must not move the editor out of download settings')
    await capture('schedule-saving-1220')
    await waitForError(); await waitForIdle()
    assert.equal(await group.evaluate(el => el.closest('details') !== null), true, 'Save failure must not relocate the form')
    assert.equal(mutations().length, beforeSaveRequests + 1)
    assert.equal(tasks[0].startAt, undefined)
    assert.equal(await date.inputValue(), format(customAt).date)
    assert.equal(await time.inputValue(), format(customAt).time)
    assert.equal(await group.getAttribute('aria-describedby'), 'task-schedule-status')
    await capture('schedule-save-failure-1220')
    await save().click()
    await waitForAppointment(customAt); await waitForIdle()
    assert.equal(await editor.count(), 0)
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-controls') === 'task-schedule-editor')
    assert.equal(await group.locator('time').getAttribute('dateTime'), new Date(customAt).toISOString())
    assert.equal(tasks[0].status, 'waiting')
    await capture('schedule-created-1220')
    checks.push('save busy state rejects duplicate input; failure retains draft and retry saves exact timestamp')

    await select(2)
    assert.equal(await group.evaluate(el => el.closest('details') === null), true)
    assert.equal(await group.locator('time').getAttribute('dateTime'), scheduledAt.toISOString())
    assert.ok((await group.locator('time').innerText()).includes(String(scheduledAt.getFullYear())), 'Existing appointment includes the year')
    for (const label of ['立即开始', '修改', '取消预约']) await group.getByRole('button', { name: label, exact: true }).waitFor()
    const beforeEdit = mutations().length
    await group.getByRole('button', { name: '修改', exact: true }).click()
    const changedAt = customAt + 60 * 60 * 1000
    await fill(changedAt)
    await group.getByRole('button', { name: '取消编辑', exact: true }).click()
    assert.equal(mutations().length, beforeEdit)
    assert.equal(tasks[1].startAt, scheduledAt.getTime())
    await group.getByRole('button', { name: '修改', exact: true }).click()
    assert.equal(await date.inputValue(), format(scheduledAt).date)
    assert.equal(await time.inputValue(), format(scheduledAt).time)
    await fill(changedAt); await save().click()
    await waitForAppointment(changedAt); await waitForIdle()
    assert.equal(tasks[1].startAt, changedAt)
    checks.push('existing appointment remains outside collapsed settings; edit cancel preserves time and save changes it')

    for (const theme of ['dawn', 'walnut']) {
      await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await setSize(740, 1.25)
      await group.scrollIntoViewIfNeeded()
      await assertVisibleControls(`${theme}: scheduled controls at native 740px and 1.25x zoom`)
      await capture(`scheduled-${theme}-740-zoom-1.25`)
    }
    await setSize(1220)
    await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
    rejectNextOp = 'pause'
    const cancelFailureStart = mutations().length
    await group.getByRole('button', { name: '取消预约', exact: true }).click()
    await waitForError(); await waitForIdle()
    assert.deepEqual(mutations().slice(cancelFailureStart).map(request => request.op), ['pause'])
    assert.equal(tasks[1].startAt, changedAt)
    for (const [index, filename] of ['课程 · 01 版式.mp4', '课程 · 02 色彩.mp4'].entries()) tasks.push({ ...tasks[0], id: 3 + index, filename, title: filename, url: `https://example.com/scheduling/${3 + index}`, category: 'video', status: 'paused', startAt: null, collection: { id: 'schedule-lock-fixture', title: '预约互斥测试合集', index: index + 1, count: 2 }, activityAt: Date.now() - (3 + index) * 3600000 })
    snapshot()
    const cancelStart = mutations().length
    holdOp = 'schedule'
    await group.getByRole('button', { name: '取消预约', exact: true }).click()
    await waitForHeldReply()
    const lockedRow = win.locator('[data-task-state]').filter({ has: win.locator('[data-task-select="2"]') })
    assert.equal(await lockedRow.locator('[data-task-primary-action]').isDisabled(), true, 'Row action stays disabled between pause and clear')
    assert.equal(await inspector.locator('[data-inspector-actions]').getByRole('button', { name: /^(继续|暂停)$/ }).isDisabled(), true, 'Inspector action shares the schedule transaction lock')
    assert.equal(await inspector.getByRole('button', { name: '删除', exact: true }).isDisabled(), true, 'Inspector delete shares the transaction lock')
    await lockedRow.locator('[data-task-select]').focus()
    await win.keyboard.press('Enter')
    await win.waitForTimeout(100)
    await win.getByRole('button', { name: '传输状态', exact: true }).click()
    await win.locator('.transfer-control-popup').waitFor()
    assert.equal(await win.locator('.transfer-control-footer button').isDisabled(), true, 'Global pause cannot enter during a scheduling transaction')
    assert.deepEqual(mutations().slice(cancelStart).map(request => request.op), ['pause', 'schedule'], 'No row, Inspector, Enter or global mutation may interleave')
    await capture('schedule-lock-protects-actions-1220')
    await win.keyboard.press('Escape')
    await win.locator('.transfer-control-popup').waitFor({ state: 'hidden' })
    const collectionAction = win.locator('[data-collection-group="schedule-lock-fixture"]').getByRole('button', { name: '继续整个合集', exact: true })
    assert.equal(await collectionAction.isDisabled(), true, 'Collection action shares the transaction lock')
    await lockedRow.locator('[data-task-select]').focus()
    await win.keyboard.press('Meta+a')
    const batch = win.getByRole('toolbar', { name: '批量任务操作', exact: true })
    await batch.waitFor()
    assert.equal(await batch.getByRole('button', { name: '继续所选', exact: true }).isDisabled(), true)
    assert.equal(await batch.getByRole('button', { name: '暂停所选', exact: true }).isDisabled(), true)
    assert.equal(await batch.getByRole('button', { name: '删除所选', exact: true }).isDisabled(), true)
    await capture('schedule-lock-protects-batch-and-collection-1220')
    assert.deepEqual(mutations().slice(cancelStart).map(request => request.op), ['pause', 'schedule'])
    await select(2, { settings: true })
    releaseHeldReplies()
    await waitForAppointment(null); await waitForIdle()
    await win.waitForFunction(() => !document.querySelector('[data-task-select="2"]')?.closest('[data-task-state]')?.querySelector('[data-task-primary-action]')?.disabled)
    assert.deepEqual(mutations().slice(cancelStart).map(request => [request.op, request.startAt]), [['pause', undefined], ['schedule', null]])
    assert.equal(tasks[1].status, 'paused')
    await openDownloadSettings(win); await group.scrollIntoViewIfNeeded()
    await capture('schedule-cancelled-keeps-paused-1220')
    checks.push('cancellation stops if pause fails; success sends pause then schedule(null), never resume')
    checks.push('shared transaction lock prevents row, Inspector, Enter, global, selected-batch, delete and collection mutation between pause and clear')

    Object.assign(tasks[1], { startAt: changedAt, status: 'waiting' }); snapshot()
    await waitForAppointment(changedAt)
    rejectNextOp = 'schedule'
    const startFailureStart = mutations().length
    await group.getByRole('button', { name: '立即开始', exact: true }).click()
    await waitForError(); await waitForIdle()
    await win.waitForTimeout(260)
    assert.ok((await group.locator('#task-schedule-status').innerText()).trim(), 'Delayed Mac snapshot must not erase the clear failure')
    assert.deepEqual(mutations().slice(startFailureStart).map(request => request.op), ['pause', 'schedule'])
    assert.equal(tasks[1].startAt, pauseClearsAppointment ? null : changedAt)
    assert.equal(tasks[1].status, 'paused')
    await capture('start-clear-failure-after-pause-snapshot-1220')
    if (pauseClearsAppointment) {
      assert.equal(await inspector.getByRole('button', { name: '继续', exact: true }).isDisabled(), false)
      Object.assign(tasks[1], { startAt: changedAt, status: 'waiting' }); snapshot()
      await waitForAppointment(changedAt)
    }
    const startAt = mutations().length
    await group.getByRole('button', { name: '立即开始', exact: true }).click()
    await waitForAppointment(null); await waitForIdle()
    await win.waitForFunction(async () => (await window.ndm.request('list')).tasks.find(task => task.id === 2)?.status === 'downloading')
    assert.deepEqual(mutations().slice(startAt).map(request => [request.op, request.startAt]), [['pause', undefined], ['schedule', null], ['resume', undefined]])
    await group.scrollIntoViewIfNeeded(); await capture('schedule-started-now-1220')
    checks.push('start stops on clear failure and keeps late-snapshot error visible; successful start sends pause → schedule(null) → resume')

    Object.assign(tasks[1], { startAt: changedAt, status: 'waiting' }); snapshot()
    await waitForAppointment(changedAt)
    rejectNextOp = 'resume'
    const resumeFailureStart = mutations().length
    await group.getByRole('button', { name: '立即开始', exact: true }).click()
    await waitForError(); await waitForIdle()
    assert.deepEqual(mutations().slice(resumeFailureStart).map(request => request.op), ['pause', 'schedule', 'resume'])
    assert.equal(tasks[1].startAt, null)
    assert.equal(tasks[1].status, 'paused')
    assert.match(await group.innerText(), /预约已取消，未能确认开始下载/)
    await capture('start-resume-failure-keeps-paused-1220')
    await inspector.getByRole('button', { name: '继续', exact: true }).click()
    await win.waitForFunction(async () => (await window.ndm.request('list')).tasks.find(task => task.id === 2)?.status === 'downloading')
    checks.push('resume rejection leaves the appointment cleared and task paused; visible Continue remains usable')
  } else assert.deepEqual(mutations(), [])
  assert.deepEqual(errors, [])
  assert.deepEqual(fingerprint(), testedBuild, 'Do not replace the tested bundle during QA')
  writeFileSync(`${output}/result.json`, JSON.stringify({ phase, passed: true, commit, dirtySource, appRoot, root, testedBuild, pauseBehavior: pauseClearsAppointment ? 'Mac: pause clears appointment' : 'Windows: pause keeps appointment', checks, evidence, requests, errors, fixtureOnly: true, limitation: 'Real macOS Electron renderer with synthetic scheduling RPC receipts; Windows pause semantics are simulated, not Windows runtime QA; no actual engine persistence or timed downloads' }, null, 2))
  console.log(JSON.stringify({ phase, passed: true, output, screenshots: evidence.length }))
} catch (error) {
  writeFileSync(`${output}/result.json`, JSON.stringify({ phase, passed: false, commit, error: error.stack, evidence, requests, errors }, null, 2))
  if (app) {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')).catch(() => null)
    if (png) writeFileSync(`${output}/failure.png`, Buffer.from(png, 'base64'))
  }
  throw error
} finally {
  heldReplies.length = 0
  for (const timer of timers) clearTimeout(timer)
  await app?.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
