// Real Electron main/preload/renderer against a private TCP fixture host.
// All tasks/files are synthetic. Shell and clipboard IPC return captured fixture
// receipts; this verifies UI command delivery, not native file opening/downloads.
// Run `node scripts/qa-task-row-actions.mjs` after building this checkout.
// --before records the old UI only. To use an independently built git archive,
// set NDM_QA_TASK_ACTIONS_APP_ROOT and NDM_QA_TASK_ACTIONS_SOURCE_COMMIT.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const before = process.argv.includes('--before')
const phase = before ? 'before' : 'after'
const repository = fileURLToPath(new URL('..', import.meta.url))
const appRepository = process.env.NDM_QA_TASK_ACTIONS_APP_ROOT || repository
const sourceCommit = process.env.NDM_QA_TASK_ACTIONS_SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
const output = resolve(repository, process.env.NDM_QA_TASK_ACTIONS_OUTPUT || 'docs/design/assets/2026-09-12-task-actions', phase)
const root = mkdtempSync('/tmp/ndm-task-row-actions-')
mkdirSync(output, { recursive: true })
mkdirSync(`${root}/files`, { recursive: true })
const MiB = 1024 ** 2
const now = Date.now()
const tasks = [
  { id: 1, filename: '沿海公路 · 4K 剪辑素材.mp4', category: 'video', status: 'downloading', fileSize: 1280 * MiB, completedBytes: 704 * MiB, bytesPerSecond: 8.4 * MiB },
  { id: 2, filename: 'Studio — 品牌设计资源.zip', category: 'compressed', status: 'paused', fileSize: 246 * MiB, completedBytes: 101 * MiB },
  { id: 3, filename: '2026 夏季摄影精选.zip', category: 'compressed', status: 'error', fileSize: 84 * MiB, errorText: '合成测试：连接暂时中断', diagnostic: { title: '连接暂时中断', summary: '连接中断，可重试', message: '网络连接已中断，请重试下载。', primaryAction: 'retry' } },
  { id: 4, filename: '设计系统工作手册.pdf', category: 'document', status: 'complete', fileSize: 12.8 * MiB, completedBytes: 12.8 * MiB },
  { id: 5, filename: '城市声音 · 现场录音.wav', category: 'audio', status: 'waiting', fileSize: 162 * MiB },
  { id: 6, filename: '讲座回放 — 下载链接已过期.mp4', category: 'video', status: 'error', fileSize: 320 * MiB, errorText: '合成测试：下载地址过期', diagnostic: { title: '下载链接已过期', summary: '需要更新下载链接', message: '更新下载链接后可继续下载。', primaryAction: 'renew' } },
  { id: 7, filename: '设计课程 — 需要返回来源页面.mp4', category: 'video', status: 'error', pageURL: 'https://example.com/course', fileSize: 480 * MiB, errorText: '合成测试：来源页面会话失效', diagnostic: { title: '请返回来源页面', summary: '需要刷新来源页面', message: '打开来源页面，重新获取可用下载链接。', primaryAction: 'openPage' } }
].map((task, index) => ({ title: task.filename, url: `https://example.com/fixture/${task.id}`, source: 'example.com', folderPath: `${root}/files`, completedBytes: 0, bytesPerSecond: 0, activityAt: now - index * 3600000, connections: 4, segments: [], ...task }))
for (const task of tasks.filter(task => task.status === 'complete')) writeFileSync(`${root}/files/${task.filename}`, 'NDM synthetic UI command fixture; not a downloaded document.\n')
const sockets = new Set(), timers = new Set(), requests = [], evidence = [], checks = [], errors = []
let restartAttempts = 0
const send = (socket, body) => { if (!socket.destroyed) socket.write(JSON.stringify(body) + '\n') }
const snapshot = () => { for (const socket of sockets) send(socket, { op: 'snapshot', tasks }) }
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', error => errors.push(`fixture socket: ${error.message}`))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push({ op: request.op, taskID: request.taskID })
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: `${root}/files`, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, expectedRelayVersion: '2.0.0', relayClients: [] }
      if (['resume', 'pause', 'restart'].includes(request.op)) {
        const task = tasks.find(task => task.id === request.taskID)
        assert.ok(task, 'Only fixture task IDs may be mutated')
        const fail = request.op === 'restart' && ++restartAttempts === 1
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (fail) send(socket, { ...reply, ok: false, error: '合成测试：连接仍不可用，请重试。' })
          else {
            task.status = request.op === 'pause' && !task.isLiveRecording ? 'paused' : 'downloading'
            task.bytesPerSecond = request.op === 'pause' ? 0 : 4.2 * MiB
            if (request.op === 'pause' && task.isLiveRecording) task.phase = 'merging'
            delete task.diagnostic; delete task.errorText
            send(socket, reply); snapshot()
          }
        }, 800)
        timers.add(timer)
      } else send(socket, reply)
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
try {
  const launchEnv = { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  // Each run begins with onboarding, so clipboard polling remains disabled until
  // the private IPC handlers below are installed and onboarding is dismissed.
  app = await electron.launch({ args: ['.', `--user-data-dir=${root}/electron`], cwd: appRepository, env: launchEnv })
  const win = await app.firstWindow()
  win.on('pageerror', error => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain }, fixtureRoot) => {
    globalThis.__taskActionReceipts = []
    const handlers = {
      'system:read-clipboard': () => '',
      'system:clipboard-snapshot': () => ({ text: '', changeCount: 0 }),
      'system:write-clipboard': text => {
        if (globalThis.__taskActionCopyFails) { globalThis.__taskActionCopyFails = false; throw new Error('Synthetic clipboard failure') }
        return text.startsWith('https://example.com/fixture/')
      },
      'system:open-path': path => path.startsWith(`${fixtureRoot}/files/`) ? '' : 'Outside fixture',
      'system:quick-look': path => path.startsWith(`${fixtureRoot}/files/`),
      'system:reveal-file': path => path.startsWith(`${fixtureRoot}/files/`),
      'system:open-external': url => url.startsWith('https://example.com/')
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, value) => {
        if (!['system:read-clipboard', 'system:clipboard-snapshot'].includes(channel)) globalThis.__taskActionReceipts.push({ channel, value })
        return handler(value)
      })
    }
  }, root)
  await completeOnboarding(win)
  await win.locator('[data-task-select="2"]').waitFor({ timeout: 12000 }).catch(async error => {
    await win.screenshot({ path: `${output}/startup-failure.png` })
    console.error(JSON.stringify({ requests, body: await win.locator('body').innerText() }))
    throw error
  })
  if (before) assert.equal(await win.locator('[data-task-primary-action]').count(), 0, '--before requires an old build; do not label the redesigned renderer as a baseline')
  const row = id => win.locator('[data-task-state]').filter({ has: win.locator(`[data-task-select="${id}"]`) })
  const setSize = async (width, height = 820) => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    await win.waitForTimeout(260)
  }
  const setZoom = async value => {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), value)
    await win.waitForTimeout(260)
  }
  const setTheme = async theme => { await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme); await win.waitForTimeout(150) }
  const measure = () => win.evaluate(() => {
    const rect = el => el ? Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom'].map(key => [key, el.getBoundingClientRect()[key]])) : null
    return { viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }, rows: [...document.querySelectorAll('[data-task-state]')].map(el => ({ id: el.querySelector('[data-task-select]')?.getAttribute('data-task-select'), state: el.getAttribute('data-task-state'), rect: rect(el), title: rect(el.querySelector('[data-task-title]')), actions: rect(el.querySelector('[data-row-actions]')), buttons: [...el.querySelectorAll('[data-row-actions] button')].map(button => ({ label: button.getAttribute('aria-label'), text: button.textContent, opacity: getComputedStyle(button).opacity, rect: rect(button) })) })) }
  })
  const capture = async (name, { hover } = {}) => {
    if (hover) await row(hover).hover(); else await win.mouse.move(8, 8)
    await win.waitForTimeout(160)
    // Playwright's page screenshot crops Electron at non-1x native zoom. Capture
    // the owning BrowserWindow surface to retain the actual macOS window.
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(`${output}/${name}.png`, Buffer.from(png, 'base64'))
    evidence.push({ name, ...await measure() })
  }
  await setSize(1220)
  for (const theme of ['dawn', 'noon', 'walnut']) {
    await setTheme(theme)
    await capture(`mixed-${theme}-1220`)
  }
  await setTheme('dawn')
  await capture('mixed-hover-paused-1220', { hover: 2 })
  await row(3).locator('[data-task-select]').click()
  await win.locator('#task-inspector').waitFor()
  await capture('selected-error-detail-1220')
  await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await row(2).locator('[data-task-select]').click()
  await win.locator('#task-inspector').waitFor()
  await capture('selected-paused-detail-1220')
  await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await win.locator('[data-hero-content="1"] h2').click()
  await win.locator('#task-inspector').waitFor()
  await capture('selected-active-detail-1220')
  await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await setSize(740, 820)
  await capture('mixed-dawn-740')
  if (!before) {
    await setSize(1220)
    const primary = id => row(id).locator('[data-task-primary-action]')
    const more = id => row(id).getByRole('button', { name: `更多操作：${tasks.find(task => task.id === id).title}`, exact: true })
    const waitForState = (id, state) => win.waitForFunction(({ id, state }) => document.querySelector(`[data-task-select="${id}"]`)?.closest('[data-task-state]')?.getAttribute('data-task-state') === state, { id, state })
    const receipt = () => app.evaluate(() => globalThis.__taskActionReceipts)
    const checkLayout = async label => {
      const layout = await measure()
      assert.ok(layout.viewport.scrollWidth <= layout.viewport.width + 1, `${label}: no document horizontal overflow`)
      for (const taskRow of layout.rows.filter(taskRow => taskRow.rect.bottom > 0 && taskRow.rect.y < layout.viewport.height)) {
        assert.equal(taskRow.buttons.length, 2, `${label}: one primary and one more button`)
        assert.ok(taskRow.buttons[0].text.trim(), `${label}: primary action has visible text`)
        assert.ok(taskRow.actions.x >= taskRow.rect.x && taskRow.actions.right <= taskRow.rect.right + 1, `${label}: reserved actions fit the row`)
        assert.ok(taskRow.actions.x >= 0 && taskRow.actions.right <= layout.viewport.width + 1, `${label}: actions fit viewport`)
        assert.ok(taskRow.title.right <= taskRow.actions.x + 1, `${label}: title never overlaps actions`)
        assert.ok(taskRow.title.width >= 54, `${label}: title keeps a readable minimum width`)
      }
      checks.push(label)
    }
    await checkLayout('1220: persistent primary actions and readable filename')
    const restingGeometry = await row(2).locator('[data-row-actions]').boundingBox()
    const restingTitle = await row(2).locator('[data-task-title]').boundingBox()
    await row(2).hover()
    assert.deepEqual(await row(2).locator('[data-row-actions]').boundingBox(), restingGeometry, 'Hover does not move or resize actions')
    assert.deepEqual(await row(2).locator('[data-task-title]').boundingBox(), restingTitle, 'Hover does not move or shrink filenames')
    assert.equal(await row(2).locator('[data-task-title]').evaluate(el => getComputedStyle(el).paddingInlineEnd), '0px', 'Hover does not keep the retired action-overlay inset')
    checks.push('hover leaves action geometry stable')

    await primary(2).click()
    await win.waitForFunction(() => document.querySelector('[data-task-select="2"]')?.closest('[data-task-state]')?.querySelector('[data-task-primary-action]')?.getAttribute('aria-busy') === 'true')
    assert.equal(await primary(2).isDisabled(), true)
    await capture('resume-busy-1220')
    await waitForState(2, 'downloading')
    assert.equal(await primary(2).getAttribute('aria-label'), '暂停下载')
    await capture('resume-confirmed-1220')
    await primary(2).click()
    await waitForState(2, 'paused')
    assert.equal(await primary(2).getAttribute('aria-label'), '继续下载')
    checks.push('paused → busy disabled → downloading → paused through fixture RPC')

    await primary(3).click()
    await win.locator('#task-action-status').waitFor()
    assert.match(await win.locator('#task-action-status').innerText(), /未能重试.*2026 夏季摄影精选.*请重试/)
    await waitForState(3, 'error')
    assert.equal(await primary(3).getAttribute('aria-describedby'), 'task-action-status')
    assert.equal(await primary(3).isDisabled(), false)
    await capture('retry-failure-feedback-1220')
    await primary(3).click()
    await waitForState(3, 'downloading')
    assert.equal(await win.locator('#task-action-status').count(), 0)
    checks.push('retry rejection keeps task actionable, exposes associated feedback, and permits successful retry')

    for (const [id, expectedAction] of [[6, '更新下载链接…'], [7, '打开来源页面']]) {
      const priorMutations = requests.filter(request => ['restart', 'resume'].includes(request.op)).length
      assert.equal(await primary(id).getAttribute('aria-label'), '查看下载问题与处理方式')
      await primary(id).click()
      await win.locator('#task-inspector').waitFor()
      await win.locator('#task-inspector').getByRole('button', { name: expectedAction, exact: true }).waitFor()
      assert.match(await win.locator('#task-inspector').innerText(), new RegExp(tasks.find(task => task.id === id).diagnostic.title))
      assert.equal(requests.filter(request => ['restart', 'resume'].includes(request.op)).length, priorMutations)
      await capture(`diagnostic-${id === 6 ? 'renew' : 'source'}-detail-1220`)
      await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      await row(id).locator('[data-task-select]').focus()
      await win.keyboard.press('Enter')
      await win.locator('#task-inspector').getByRole('button', { name: expectedAction, exact: true }).waitFor()
      assert.equal(requests.filter(request => ['restart', 'resume'].includes(request.op)).length, priorMutations)
      await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    }
    checks.push('renew and source-page diagnostics open the matching recovery details without restarting')

    // Keyboard selection can move while DOM focus remains on the originally
    // clicked row. Enter must act on selection, including diagnostic recovery.
    const ordinaryTask = tasks.find(task => task.id === 2)
    const renewalTask = tasks.find(task => task.id === 6)
    const priorActivities = [ordinaryTask.activityAt, renewalTask.activityAt]
    ordinaryTask.activityAt = now + 2000
    renewalTask.activityAt = now + 1000
    snapshot()
    await win.waitForFunction(() => [...document.querySelectorAll('[data-task-select]')].slice(0, 2).map(el => el.getAttribute('data-task-select')).join(',') === '2,6')
    await row(2).locator('[data-task-select]').click()
    await win.keyboard.press('ArrowDown')
    assert.equal(await row(6).locator('[data-task-select]').getAttribute('aria-pressed'), 'true')
    assert.equal(await row(2).locator('[data-task-select]').evaluate(el => el === document.activeElement), true)
    const priorKeyboardMutations = requests.filter(request => ['resume', 'restart'].includes(request.op)).length
    await win.keyboard.press('Enter')
    await win.locator('#task-inspector').getByRole('button', { name: '更新下载链接…', exact: true }).waitFor()
    assert.equal(requests.filter(request => ['resume', 'restart'].includes(request.op)).length, priorKeyboardMutations)
    await row(6).locator('[data-task-select]').click()
    await win.keyboard.press('ArrowUp')
    assert.equal(await row(2).locator('[data-task-select]').getAttribute('aria-pressed'), 'true')
    assert.equal(await row(6).locator('[data-task-select]').evaluate(el => el === document.activeElement), true)
    await win.keyboard.press('Enter')
    await waitForState(2, 'downloading')
    assert.equal(requests.filter(request => request.taskID === 6 && ['resume', 'restart'].includes(request.op)).length, 0)
    await primary(2).click()
    await waitForState(2, 'paused')
    await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    ordinaryTask.activityAt = priorActivities[0]
    renewalTask.activityAt = priorActivities[1]
    snapshot()
    checks.push('ArrowDown/ArrowUp change selection without focus; Enter follows the selected recovery or ordinary task')

    await primary(4).click()
    await win.waitForTimeout(100)
    assert.equal((await receipt()).filter(item => item.channel === 'system:open-path').length, 1)
    await more(4).click()
    const menu = win.getByRole('menu')
    await menu.waitFor()
    await capture('completed-menu-1220')
    await menu.getByRole('menuitem', { name: '快速预览', exact: false }).click()
    await win.waitForTimeout(100)
    assert.equal((await receipt()).filter(item => item.channel === 'system:quick-look').length, 1)
    await more(4).click()
    await menu.getByRole('menuitem', { name: '在访达中显示', exact: false }).click()
    await win.waitForTimeout(100)
    assert.equal((await receipt()).filter(item => item.channel === 'system:reveal-file').length, 1)
    await more(4).click()
    await app.evaluate(() => { globalThis.__taskActionCopyFails = true })
    await menu.getByRole('menuitem', { name: '复制下载链接', exact: true }).click()
    await menu.getByRole('menuitem', { name: '复制失败，请重试', exact: true }).waitFor()
    await capture('completed-copy-failure-1220')
    await menu.getByRole('menuitem', { name: '复制失败，请重试', exact: true }).click()
    await menu.getByRole('menuitem', { name: '已复制链接', exact: true }).waitFor()
    assert.equal((await receipt()).filter(item => item.channel === 'system:write-clipboard').length, 2)
    await capture('completed-copy-feedback-1220')
    await win.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await more(4).evaluate(el => el === document.activeElement), true, 'Escape restores focus to the trigger')
    await win.keyboard.press('ArrowDown')
    await menu.waitFor()
    assert.equal(await menu.getByRole('menuitem').first().evaluate(el => el === document.activeElement), true)
    await win.keyboard.press('Escape')
    assert.equal(await more(4).evaluate(el => el === document.activeElement), true)
    const beforeEnter = (await receipt()).length
    await win.keyboard.press('Enter')
    await menu.waitFor()
    assert.equal((await receipt()).length, beforeEnter, 'Enter on a focused more button opens its menu without activating the row')
    await win.keyboard.press('Escape')
    checks.push('completed file open, preview, reveal and copy deliver only private IPC receipts')
    checks.push('copy failure is visible and retry succeeds; keyboard opens menu and Escape restores trigger focus')

    for (const theme of ['dawn', 'noon', 'walnut']) {
      await setTheme(theme)
      for (const zoom of [1, 1.25, 1.5]) {
        await setZoom(zoom)
        await setSize(740)
        await row(2).scrollIntoViewIfNeeded()
        await checkLayout(`${theme}: native 740px window at real Electron zoom ${zoom}`)
        await capture(`narrow-${theme}-740-zoom-${zoom}`)
      }
    }
    await more(4).click()
    await menu.waitFor()
    const menuBounds = await menu.boundingBox()
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= viewport.width + 1)
    assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= viewport.height + 1)
    await capture('narrow-walnut-740-zoom-1.5-menu')
    await win.keyboard.press('Escape')
    checks.push('narrow 1.5x menu stays inside the actual viewport')
    await setZoom(1)
    await setSize(1220)
    await setTheme('dawn')
    const recordingTask = tasks.find(task => task.id === 5)
    Object.assign(recordingTask, { status: 'downloading', isLiveRecording: true, phase: 'transferring', recordedDuration: 134, completedBytes: 42 * MiB, bytesPerSecond: 1.2 * MiB })
    snapshot()
    await waitForState(5, 'downloading')
    assert.equal(await primary(5).getAttribute('aria-label'), '停止并保存录制')
    await primary(5).click()
    await win.waitForFunction(() => document.querySelector('[data-task-select="5"]')?.closest('[data-task-state]')?.querySelector('[data-task-primary-action]')?.getAttribute('aria-label') === '正在保存录制')
    assert.equal(await primary(5).isDisabled(), true)
    const saveRequests = requests.filter(request => request.taskID === 5).length
    await row(5).locator('[data-task-select]').focus()
    await win.keyboard.press('Enter')
    assert.equal(requests.filter(request => request.taskID === 5).length, saveRequests)
    await capture('recording-save-disabled-1220')
    checks.push('recording stop/save becomes disabled while merging; Enter cannot enqueue another operation')

    const opensBeforeDoubleClick = (await receipt()).filter(item => item.channel === 'system:open-path').length
    await row(4).locator('[data-task-select]').dblclick()
    await win.waitForTimeout(100)
    assert.equal((await receipt()).filter(item => item.channel === 'system:open-path').length, opensBeforeDoubleClick + 1)
    if (await win.getByRole('button', { name: '关闭任务详情', exact: true }).isVisible()) await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    checks.push('completed-row double click still delivers open-file')

    await win.locator('#main-sidebar').getByRole('button', { name: /^下载中/ }).click()
    await row(3).waitFor()
    await setSize(740)
    await setZoom(1.25)
    await row(3).scrollIntoViewIfNeeded()
    await checkLayout('active view: native 740px at 1.25x retains separate actions and transfer metadata')
    await capture('active-dawn-740-zoom-1.25')

    await setZoom(1)
    await setSize(1220)
    await win.locator('#main-sidebar').getByRole('button', { name: /^全部/ }).click()
    for (const [index, filename] of ['设计课程 · 01 版式.mp4', '设计课程 · 02 色彩.mp4'].entries()) {
      tasks.push({ ...tasks.find(task => task.id === 2), id: 8 + index, filename, title: filename, url: `https://example.com/fixture/${8 + index}`, category: 'video', status: 'paused', activityAt: now + (2 - index) * 1000, collection: { id: 'fixture-course', title: '设计课程 · 合成合集', index: index + 1, count: 2 } })
    }
    snapshot()
    await win.getByRole('button', { name: '展开合集 设计课程 · 合成合集', exact: true }).click()
    await row(8).waitFor()
    await setSize(740)
    await setZoom(1.25)
    await row(8).scrollIntoViewIfNeeded()
    await checkLayout('expanded collection: native 740px at 1.25x reserves child row actions')
    await capture('expanded-collection-dawn-740-zoom-1.25')
    const collectionBox = await win.locator('[data-collection-group="fixture-course"]').boundingBox()
    assert.ok(collectionBox.x >= 0 && collectionBox.x + collectionBox.width <= (await win.evaluate(() => innerWidth)) + 1)
    checks.push('expanded collection remains within narrow viewport')
    const commandReceipts = await receipt()
    assert.ok(commandReceipts.every(item => item.value.startsWith(`${root}/files/`) || item.value.startsWith('https://example.com/fixture/')))
    checks.push('all file/clipboard receipts reference synthetic paths or URLs')
    writeFileSync(`${output}/command-receipts.json`, JSON.stringify(commandReceipts, null, 2))
  }
  assert.deepEqual(errors, [])
  const mutations = requests.filter(request => ['add', 'addMedia', 'remove', 'removeMany', 'resume', 'pause', 'restart', 'renew'].includes(request.op))
  if (before) assert.deepEqual(mutations, [])
  const report = { phase, passed: true, commit: sourceCommit, appRepository, root, output, fixtureOnly: true, realRuntime: 'Electron main + preload + renderer; native engine replaced by private TCP fixture', clipboardAndFileActions: 'private IPC receipts; no real clipboard or external app action', checks, evidence, requests, errors }
  writeFileSync(`${output}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ phase, passed: true, output, screenshots: evidence.length }))
} catch (error) {
  writeFileSync(`${output}/result.json`, JSON.stringify({ phase, passed: false, error: error.stack, checks, evidence, requests, errors }, null, 2))
  if (app) {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')).catch(() => null)
    if (png) writeFileSync(`${output}/failure.png`, Buffer.from(png, 'base64'))
  }
  throw error
} finally {
  for (const timer of timers) clearTimeout(timer)
  await app?.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
