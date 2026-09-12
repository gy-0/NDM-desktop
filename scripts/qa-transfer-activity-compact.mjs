// Real Electron renderer/main/preload with a private engine and intercepted
// installation/file commands. This never mounts, copies, or installs an app.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const before = process.argv.includes('--before')
const stage = before ? 'before' : 'after'
const appRoot = process.env.NDM_QA_TRANSFER_APP_ROOT || repository
const fingerprint = () => Object.fromEntries(['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html', ...readdirSync(`${appRoot}/out/renderer/assets`).filter(name => /\.(js|css)$/.test(name)).sort().map(name => `out/renderer/assets/${name}`)].map(path => [path, createHash('sha256').update(readFileSync(`${appRoot}/${path}`)).digest('hex')]))
const buildFingerprint = fingerprint()
const sourceCommit = resolve(appRoot) === resolve(repository) ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim() : null
const output = resolve(repository, 'docs/design/assets/2026-09-12-transfer-activity', stage)
const root = mkdtempSync('/tmp/ndm-transfer-activity-')
mkdirSync(output, { recursive: true })
mkdirSync(`${root}/files`)
const shortName = 'Moss.dmg'
const longName = 'Moss Studio — 2026 专业创作工具与完整素材资源包 Apple Silicon.dmg'
const fileSize = 134217728
const task = { id: 99001, title: shortName, filename: shortName, folderPath: `${root}/files`, url: 'https://example.test/moss.dmg', source: 'example.test', category: 'application', status: 'complete', fileSize, completedBytes: fileSize, progressFraction: 1, bytesPerSecond: 0, connections: 4, segments: [] }
writeFileSync(`${root}/files/${shortName}`, 'Synthetic installation UI fixture. Not a disk image.')
const sockets = new Set(), requests = [], checks = [], captures = [], errors = []
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', error => errors.push(error.message))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push(request.op)
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = [task]
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: `${root}/files`, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, relayClients: [] }
      if (request.op === 'fileArtwork') reply.artwork = null
      socket.write(JSON.stringify(reply) + '\n')
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
  await app.evaluate(({ ipcMain, BrowserWindow }, fixtureRoot) => {
    globalThis.__transferReceipts = []
    globalThis.__transferFailOpen = false
    globalThis.__transferOpenDelay = 0
    globalThis.__transferInstallDelay = 0
    globalThis.__transferInstallError = ''
    for (const channel of ['system:read-clipboard', 'system:clipboard-snapshot', 'system:install-disk-image', 'system:open-path', 'system:reveal-file']) ipcMain.removeHandler(channel)
    ipcMain.handle('system:read-clipboard', () => '')
    ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0 }))
    ipcMain.handle('system:install-disk-image', async (_event, path) => {
      if (!path.startsWith(`${fixtureRoot}/files/`)) throw new Error('Non-fixture installation refused')
      globalThis.__transferReceipts.push({ command: 'install', path })
      BrowserWindow.getAllWindows()[0].webContents.send('engine:event', { op: 'installProgress', path, phase: 'preparing', detail: '正在检查安装包' })
      const error = globalThis.__transferInstallError
      await new Promise(resolve => setTimeout(resolve, globalThis.__transferInstallDelay))
      return error
    })
    ipcMain.handle('system:open-path', async (_event, path) => {
      if (!path.startsWith(fixtureRoot)) throw new Error('Non-fixture open refused')
      globalThis.__transferReceipts.push({ command: 'open', path })
      await new Promise(resolve => setTimeout(resolve, globalThis.__transferOpenDelay))
      return globalThis.__transferFailOpen ? '合成测试：暂时无法打开应用' : ''
    })
    ipcMain.handle('system:reveal-file', async (_event, path) => {
      if (!path.startsWith(fixtureRoot)) throw new Error('Non-fixture reveal refused')
      globalThis.__transferReceipts.push({ command: 'reveal', path })
      return true
    })
  }, root)
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820))
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  const send = async payload => app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send('engine:event', payload), payload)
  const progress = async (phase, detail = '', extra = {}) => {
    await send({ op: 'installProgress', path: `${root}/files/${task.filename}`, phase, detail, ...extra })
    await win.locator(`[data-testid="install-progress"][data-activity-phase="${phase}"]`).waitFor()
  }
  const complete = async (filename = shortName) => {
    if (await win.getByRole('button', { name: '关闭安装提示', exact: true }).isVisible()) {
      await win.getByRole('button', { name: '关闭安装提示', exact: true }).click()
      await win.getByTestId('install-progress').waitFor({ state: 'hidden' })
    }
    task.filename = filename; task.title = filename
    for (const socket of sockets) socket.write(JSON.stringify({ op: 'snapshot', tasks: [task] }) + '\n')
    await win.waitForFunction(filename => [...document.querySelectorAll('[data-task-title]')].some(el => el.textContent === filename), filename)
    await send({ op: 'downloadCompleted', task: { ...task, fullPath: `${root}/files/${filename}` } })
    await win.getByTestId('completion-bar').waitFor()
  }
  const surface = () => win.locator('[data-activity-path]')
  const capture = async name => {
    await win.waitForTimeout(240)
    const geometry = await surface().evaluate(el => {
      const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom } }
      return { phase: el.dataset.activityPhase, rect: rect(el), viewport: { width: innerWidth, height: innerHeight }, text: el.innerText, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, buttons: [...el.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label') || button.textContent, rect: rect(button), fontSize: getComputedStyle(button).fontSize, disabled: button.disabled })) }
    })
    const path = `${output}/${name}.png`
    const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
    if (zoom === 1) await surface().screenshot({ path })
    else {
      // DevTools element screenshots crop incorrectly at Electron page zoom.
      // Native capture keeps the actual window and card intact at 125%/150%.
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
      writeFileSync(path, Buffer.from(png, 'base64'))
    }
    captures.push({ name, path, ...geometry })
    if (!before) {
      assert.ok(geometry.rect.right <= geometry.viewport.width + 1 && geometry.rect.bottom <= geometry.viewport.height + 1, `${name}: surface fits viewport`)
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${name}: no horizontal overflow`)
      for (const button of geometry.buttons) {
        assert.ok(button.rect.height >= 32, `${name}: ${button.label} retains a usable hit target`)
        assert.ok(button.rect.x >= geometry.rect.x && button.rect.right <= geometry.rect.right + 1, `${name}: button fits surface`)
      }
    }
    return geometry
  }

  await complete()
  await capture('01-download-complete')
  if (!before) assert.equal(await surface().locator('[data-activity-size]').innerText(), '128 MB', 'The confirmed download byte count is shown')
  await win.screenshot({ path: `${output}/01-download-complete-workspace.png` })
  const completion = win.getByTestId('completion-bar')
  if (!before) {
    await win.locator('[data-task-select="99001"]').focus()
    await send({ op: 'downloadCompleted', task: { ...task, fullPath: `${root}/files/${task.filename}` } })
    assert.equal(await win.locator('[data-task-select="99001"]').evaluate(el => el === document.activeElement), true, 'Arrival preserves the current keyboard focus')
    await completion.getByRole('button', { name: '关闭完成提示', exact: true }).focus()
    await win.keyboard.press('Tab')
    assert.equal(await completion.getByRole('button', { name: '在访达中显示', exact: true }).evaluate(el => el === document.activeElement), true)
    await win.keyboard.press('Tab')
    assert.equal(await completion.getByRole('button', { name: '安装到应用程序', exact: true }).evaluate(el => el === document.activeElement), true)
    await capture('01-keyboard-focus')
    await app.evaluate(() => { globalThis.__transferInstallDelay = 700; globalThis.__transferInstallError = '合成测试：旧安装阶段回执' })
    checks.push('arrival preserves focus; Tab reaches every action at normal hit-target size')
  }
  await completion.getByRole('button', { name: '安装到应用程序', exact: true }).focus()
  await win.keyboard.press('Enter')
  await win.getByTestId('install-progress').waitFor()
  await capture('02-preparing')
  if (!before) assert.equal(await surface().locator('[data-activity-size]').innerText(), '128 MB', 'The same package retains its confirmed size when installation begins')
  for (const [phase, detail] of [['mounting', '正在读取 Moss.dmg'], ['scanning', '正在检查安装内容'], ['copying', '正在复制 Moss 到“应用程序”'], ['finishing', '正在检查安装结果'], ['waiting', '请在系统窗口中选择是否替换已有应用']]) {
    await progress(phase, detail, { appName: 'Moss' })
    await capture(`03-${phase}`)
    if (!before) assert.equal(await surface().locator('[role="progressbar"][aria-valuenow]').count(), 0, 'Install stages never claim numeric progress')
  }
  if (!before) {
    assert.ok(!(await surface().innerText()).includes('旧安装阶段回执'), 'A late completion-action error cannot overwrite a later installation stage')
    await app.evaluate(() => { globalThis.__transferInstallDelay = 0; globalThis.__transferInstallError = '' })
    checks.push('late installation reply cannot overwrite a later phase')
  }
  await progress('complete', '', { appName: 'Moss', installedPath: `${root}/Moss.app` })
  await capture('04-installed')
  if (!before) {
    await app.evaluate(() => { globalThis.__transferFailOpen = true })
    await surface().getByRole('button', { name: '打开应用', exact: true }).click()
    await surface().getByText('合成测试：暂时无法打开应用', { exact: true }).waitFor()
    await capture('04-open-failed')
    await win.waitForTimeout(8500)
    await surface().getByText('合成测试：暂时无法打开应用', { exact: true }).waitFor()
    assert.equal(await surface().getByRole('button', { name: '打开应用', exact: true }).isEnabled(), true)
    await app.evaluate(() => { globalThis.__transferFailOpen = false })
    checks.push('an application open failure remains visible and retryable after 8.5 seconds')
  }
  await surface().getByRole('button', { name: '打开应用', exact: true }).focus()
  await win.keyboard.press('Enter')
  await surface().waitFor({ state: 'hidden' })
  checks.push('keyboard installs and opens through intercepted commands')

  await progress('failed', '无法将应用复制到目标文件夹。请检查权限后重试。', { appName: 'Moss' })
  if (!before) assert.equal(await surface().locator('[data-activity-size]').count(), 0, 'A later installation without a new completion notice cannot reuse an older size')
  await capture('05-failed')
  await surface().getByRole('button', { name: '重试安装', exact: true }).click()
  await win.locator('[data-activity-phase="preparing"]').waitFor()
  await progress('cancelled', '安装包已保留，你可以稍后继续安装。', { appName: 'Moss' })
  await capture('06-cancelled')
  if (!before) {
    await surface().getByRole('button', { name: '重新安装', exact: true }).focus()
    await win.keyboard.press('Space')
    await win.locator('[data-activity-phase="preparing"]').waitFor()
    checks.push('failure and cancellation each retain a direct retry path')
  }
  await progress('complete', '', { appName: 'Moss', installedPath: `${root}/Moss.app` })
  await complete(longName)
  await capture('07-long-filename')

  if (!before) {
    await surface().getByRole('button', { name: '安装到应用程序', exact: true }).click()
    await progress('copying', '正在复制 Moss 到“应用程序”', { appName: 'Moss' })
    await capture('08-long-installing')
    await win.screenshot({ path: `${output}/08-installing-workspace.png` })
    await progress('complete', '', { appName: 'Moss', installedPath: `${root}/Moss.app` })
    await app.evaluate(() => { globalThis.__transferOpenDelay = 1000 })
    await surface().getByRole('button', { name: '打开应用', exact: true }).click()
    await surface().getByRole('button', { name: '正在打开', exact: true }).waitFor()
    await complete('Next download.dmg')
    await surface().getByRole('button', { name: '安装到应用程序', exact: true }).click()
    await progress('copying', '正在复制新应用', { appName: 'Next download' })
    await win.waitForTimeout(1100)
    assert.equal(await surface().getAttribute('data-activity-path'), `${root}/files/Next download.dmg`)
    assert.equal(await surface().getAttribute('data-activity-phase'), 'copying')
    assert.ok(!(await surface().innerText()).includes('暂时无法打开'))
    await app.evaluate(() => { globalThis.__transferOpenDelay = 0 })
    checks.push('a late open receipt cannot dismiss or change another download installation')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(740, 640); w.webContents.setZoomFactor(1.5) })
    await win.evaluate(() => { document.documentElement.dataset.theme = 'walnut' })
    await progress('failed', '无法将应用复制到目标文件夹。请检查权限后重试。', { appName: 'Moss' })
    await capture('09-narrow-dark-150-percent')
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await progress('copying', '正在复制 Moss 到“应用程序”', { appName: 'Moss' })
    await capture('10-reduced-motion')
    assert.equal(await surface().locator('[data-install-indicator] > span').isVisible(), false, 'Reduced motion does not freeze a fake partial progress fill')
    await progress('complete', '', { appName: 'Moss', installedPath: `${root}/Moss.app` })
    task.fileSize = 0; task.completedBytes = 0
    await complete('Unknown-size.dmg')
    assert.equal(await surface().locator('[data-activity-size]').count(), 0, 'Missing byte counts never borrow the previous download size')
    await capture('11-unknown-size')
    checks.push('confirmed file size survives installation; missing size is omitted')
    const baseline = JSON.parse(readFileSync(resolve(repository, 'docs/design/assets/2026-09-12-transfer-activity/before/report.json'), 'utf8'))
    for (const name of ['01-download-complete', '02-preparing', '03-copying', '04-installed']) {
      const old = baseline.captures.find(c => c.name === name)
      const current = captures.find(c => c.name === name)
      assert.ok(current.rect.height <= old.rect.height - 20, `${name}: material height reduction`)
    }
    checks.push('core stages each save at least 20 CSS px without reducing button hit targets')
    checks.push('long filename, narrow actual Electron 150% zoom, dark theme, reduced motion')
  }
  const receipts = await app.evaluate(() => globalThis.__transferReceipts)
  assert.ok(receipts.every(item => item.path.startsWith(root)))
  assert.ok(!requests.some(op => ['add', 'addMedia', 'remove', 'removeMany', 'resume', 'pause', 'restart'].includes(op)))
  assert.deepEqual(errors, [])
  assert.deepEqual(fingerprint(), buildFingerprint, 'Do not replace the tested bundle during QA')
  const report = { passed: true, stage, root, appRoot, sourceCommit, buildFingerprint, buildFingerprintCollection: 'pre-run and post-run verified equal', scope: 'Real Electron main/preload/renderer; isolated TCP engine fixture; installation and shell commands intercepted, no real app installed or opened.', captures, checks, receipts, requests, errors }
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: true, stage, output, captures: captures.map(({ name, rect }) => ({ name, width: rect.width, height: rect.height })), checks, receipts }))
} finally {
  await app?.close()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
