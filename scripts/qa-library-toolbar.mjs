// Real Electron renderer, isolated fixture host. Exercises the work area without
// accessing the production library, browser session, clipboard or downloads.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const root = mkdtempSync('/tmp/ndm-library-toolbar-')
const tasks = [
  ['Design handbook.pdf', 'document', 'complete'],
  ['Studio assets.zip', 'compressed', 'paused'],
  ['Field notes.pdf', 'document', 'error']
].map(([filename, category, status], index) => ({ id: index + 1, filename, title: filename, category, status, url: `https://example.com/files/${index}`, source: 'example.com', folderPath: root, fileSize: (index + 1) * 1024 ** 2, completedBytes: status === 'complete' ? 1024 ** 2 : 0, bytesPerSecond: 0, activityAt: Date.now() - index * 3600000, connections: 4, segments: [] }))
const sockets = new Set(), requests = [], evidence = [], errors = []
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push(request.op)
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: root, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, expectedRelayVersion: '2.0.0', relayClients: [] }
      socket.write(JSON.stringify(reply) + '\n')
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
try {
  const executablePath = process.env.NDM_QA_APP_PATH?.trim()
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${root}/electron`] } : { args: ['.', `--user-data-dir=${root}/electron`] }), env: { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: `${root}/engine`, NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['system:read-clipboard', 'system:clipboard-snapshot', 'system:write-clipboard']) ipcMain.removeHandler(channel)
    ipcMain.handle('system:read-clipboard', () => '')
    ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0 }))
    ipcMain.handle('system:write-clipboard', () => true)
  })
  await completeOnboarding(win); await win.locator('[data-task-select="1"]').waitFor()
  win.on('pageerror', error => errors.push(error.message))
  const panel = win.locator('[data-library-filters]')
  const setSize = async (width, height = 820) => { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]); await win.waitForTimeout(240) }
  const measure = () => win.evaluate(() => {
    const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, bottom: r.bottom } }
    return { windowWidth: innerWidth, title: rect('.library-heading'), header: rect('.task-table-header'), field: rect('.library-search [role="search"]'), sidebar: rect('#main-sidebar'), inspector: rect('#task-inspector'), controls: [...document.querySelectorAll('.library-search button')].map(el => ({ label: el.getAttribute('aria-label'), ...el.getBoundingClientRect().toJSON() })) }
  })
  const capture = async name => {
    await win.mouse.move(8, 8); await win.waitForTimeout(120)
    await win.screenshot({ path: `${root}/${name}.png`, animations: 'disabled' })
    evidence.push({ name, ...await measure() })
  }
  await setSize(1440)
  const baseline = await measure()
  assert.equal(await win.getByRole('button', { name: '快速操作', exact: true }).count(), 0)
  assert.equal(await win.getByRole('button', { name: '排序下载任务', exact: true }).count(), 0)
  assert.equal(await win.getByRole('button', { name: '筛选下载任务', exact: true }).count(), 0)
  assert.equal(await win.locator('[data-transfer-control]').innerText(), '', 'Idle transfers should be an icon, not an empty status label')
  assert.equal((await win.locator('[data-transfer-control]').boundingBox()).width, (await win.getByRole('button', { name: '显示选项', exact: true }).boundingBox()).width)
  for (const theme of ['dawn', 'noon', 'walnut']) {
    await win.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    for (const width of [1440, 1200, 1020, 1000, 980, 820, 740]) {
      await setSize(width, width < 1000 ? 680 : 820)
      const layout = await measure()
      assert.equal(layout.header.y, baseline.header.y + (width <= 760 ? 26 : 0), `The list must stay vertically fixed at width ${width}`)
      assert.ok(layout.field.width >= 210, `Usable search at ${width}`)
      assert.ok(layout.controls.every(control => control.x >= 0 && control.right <= width), `Toolbar controls fit at ${width}`)
      const sorted = [...layout.controls].sort((a, b) => a.x - b.x)
      assert.equal(sorted.at(-1).label, '切换任务详情')
      if ([1440, 980, 740].includes(width)) await capture(`idle-${theme}-${width}`)
    }
  }
  await setSize(1440)
  await win.locator('[data-task-select="1"]').click()
  await win.locator('#task-inspector').waitFor()
  await capture('selected-wide')
  const selected = await measure()
  await win.getByRole('button', { name: '显示选项', exact: true }).click(); await panel.waitFor()
  await panel.getByRole('combobox', { name: '排列方式', exact: true }).selectOption('size')
  await panel.getByRole('combobox', { name: '排列顺序', exact: true }).selectOption('asc')
  assert.deepEqual(await win.evaluate(() => JSON.parse(localStorage.getItem('ndm-task-sort'))), { key: 'size', direction: 'asc' })
  await panel.getByRole('combobox', { name: '筛选类型', exact: true }).selectOption('document')
  await panel.getByRole('combobox', { name: '最近活动时间', exact: true }).selectOption('week')
  assert.equal((await measure()).header.y, selected.header.y)
  await capture('view-options-selected')
  await win.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' })
  assert.equal(await win.getByRole('button', { name: '显示选项', exact: true }).evaluate(el => el === document.activeElement), true)
  await win.getByRole('button', { name: '清除组合筛选', exact: true }).click()
  assert.equal(await win.locator('[data-task-select]').count(), 3)
  await win.locator('[data-task-select="1"]').click()
  await win.getByRole('button', { name: '切换任务详情', exact: true }).click()
  assert.equal((await measure()).header.y, selected.header.y)
  await win.keyboard.press('Meta+f'); await win.locator('#ndm-search').fill('handbook')
  await win.keyboard.press('Escape'); assert.equal(await win.locator('#ndm-search').inputValue(), '')
  await win.keyboard.press('Escape')
  const menuItemExists = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.some(item => item.submenu?.items.some(child => child.label === '快速操作…' && child.accelerator === 'CmdOrCtrl+K')))
  assert.equal(menuItemExists, true, 'Quick actions stay discoverable in the application menu')
  await app.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === '快速操作…'); item.click() })
  await win.getByRole('dialog', { name: '快速操作', exact: true }).waitFor()
  await win.keyboard.press('Escape')
  // Fixture-only live updates prove the activity readout remains usable.
  await app.evaluate(({ BrowserWindow }, tasks) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'snapshot', tasks: tasks.map(task => ({ ...task, status: task.id < 3 ? 'downloading' : task.status, bytesPerSecond: task.id < 3 ? 3 * 1024 ** 2 : 0, completedBytes: 512 * 1024 })) }), tasks)
  await win.locator('[data-transfer-control]').getByText('2', { exact: true }).waitFor()
  await capture('active-wide')
  await setSize(740, 680); await capture('active-narrow')
  await win.getByRole('button', { name: '传输状态', exact: true }).click()
  await win.getByRole('button', { name: '暂停所有下载', exact: true }).waitFor()
  await capture('active-transfer-popover')
  assert.deepEqual(errors, [])
  assert.deepEqual(requests.filter(op => ['add', 'addMedia', 'remove', 'removeMany', 'restart', 'pause', 'resume', 'pauseAll'].includes(op)), [])
  const report = { root, passed: true, themes: 3, widths: 7, mergedViewOptions: true, preservedMenuAndKeyboardCommands: true, noUnexpectedDownloadMutations: true, evidence, errors }
  writeFileSync(`${root}/result.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, passed: true, screenshots: evidence.length, errors }))
} finally { await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
