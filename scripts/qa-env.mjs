import { fileURLToPath as repositoryFileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const APP = repositoryFileURLToPath(new URL('..', import.meta.url))

export function qaLaunchOptions(name, { seedHistory = false } = {}) {
  const slot = process.pid % 5_000
  const hostPort = 54_000 + slot
  const bridgePort = 59_000 + slot
  const root = `/tmp/ndm-${name}-qa-${process.pid}`
  const engineRoot = `${root}/engine`

  mkdirSync(engineRoot, { recursive: true })
  if (seedHistory) {
    const source = `${homedir()}/Library/Application Support/dev.ndm.open/NeatDB.db`
    if (existsSync(source)) copyFileSync(source, `${engineRoot}/NeatDB.db`)
  }

  const packagedExecutable = process.env.NDM_QA_APP_PATH?.trim()

  // Keep every isolated QA launch silent, including onboarding and completion
  // cues that can fire before a test gets a chance to change renderer settings.
  return {
    ...(packagedExecutable
      ? {
          executablePath: packagedExecutable,
          args: ['--mute-audio', `--user-data-dir=${root}/electron`]
        }
      : { args: ['.', '--mute-audio', `--user-data-dir=${root}/electron`] }),
    cwd: APP,
    env: {
      ...process.env,
      NDM_HOST_PORT: String(hostPort),
      NDM_BRIDGE_PORT: String(bridgePort),
      NDM_DISABLE_LEGACY_BRIDGE: '1',
      NDM_SUPPORT_DIR: engineRoot
    }
  }
}

export async function completeOnboarding(win, { exerciseAllSteps = false } = {}) {
  const dialog = win.getByRole('dialog', { name: '欢迎使用 NDM' })
  if (!await dialog.isVisible().catch(() => false)) return 0

  if (!exerciseAllSteps) {
    await dialog.getByRole('button', { name: '跳过' }).click()
    await dialog.waitFor({ state: 'hidden' })
    return 1
  }

  // Walk every step through the "next" control; it disappears on the last one.
  let steps = 1
  for (;;) {
    const next = dialog.locator('[data-onboarding-next]')
    if (!await next.isVisible().catch(() => false)) break
    await next.click()
    steps += 1
    await win.waitForTimeout(260)
  }
  await dialog.locator('[data-onboarding-finish]').click()
  await dialog.waitFor({ state: 'hidden' })
  return steps
}

/**
 * Details-pane sections collapse behind their own summaries ("下载设置" holds
 * connections, the per-task limit and the appointment). Open the named one
 * before reading or driving its content,
 * and leave an already-open one alone (a blind click would close it again).
 */
export async function openInspectorDisclosure(win, label) {
  const summary = win.locator('#task-inspector summary').getByText(label, { exact: true })
  // The pane can mount a beat after whatever opened it (a row click, a finished
  // composer submission), so wait for the summary instead of racing it.
  const appeared = await summary.first().waitFor({ state: 'attached', timeout: 5_000 }).then(() => true).catch(() => false)
  if (!appeared) return false
  const target = summary.first()
  const alreadyOpen = await target.evaluate((element) => element.closest('details')?.open === true)
  if (alreadyOpen) return true
  await target.click()
  return true
}

export async function openDownloadSettings(win) {
  return await openInspectorDisclosure(win, '下载设置')
}

/** Keep isolated QA from inspecting the user's clipboard; the real host stays live. */
export async function isolateQAClipboard(app) {
  await app.evaluate(({ app, ipcMain }) => {
    if (!app.commandLine.hasSwitch('mute-audio')) throw new Error('QA must be silent')
    ipcMain.removeHandler('system:read-clipboard')
    ipcMain.handle('system:read-clipboard', () => '')
    ipcMain.removeHandler('system:clipboard-snapshot')
    ipcMain.handle('system:clipboard-snapshot', () => ({ text: '', changeCount: 0, selfWritten: false }))
  })
}

export async function captureQAScreenshot(win, name) {
  const directory = process.env.NDM_QA_SCREENSHOT_DIR?.trim()
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await win.evaluate(() => document.fonts.ready)
  await win.waitForTimeout(600)
  await win.screenshot({ path: `${directory}/${name}.png` })
}


/** Tear down only this harness's synthetic profile, even if quit awaits a renderer ACK. */
export async function closeQAApp(app) {
  if (!app) return
  await app.evaluate(({ app, BrowserWindow }) => {
    if (!process.env.NDM_SUPPORT_DIR?.startsWith('/tmp/ndm-')) throw new Error('Refusing non-QA teardown')
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  }).catch(() => {})
  let timer
  try {
    await Promise.race([
      app.close(),
      new Promise((resolve) => { timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve() }, 5000) })
    ])
  } finally { clearTimeout(timer) }
}


/** Playwright waitForFunction treats a Promise as truthy; explicitly await IPC polls. */
export async function waitForAsyncState(win, predicate, argument, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await win.evaluate(predicate, argument)) return
    await win.waitForTimeout(200)
  }
  throw new Error(`Asynchronous QA state did not match within ${timeout}ms`)
}

/** Actual packaged window/theme variants with the same persisted synthetic task. */
export async function captureQAWindowVariants(app, win, state) {
  if (!process.env.NDM_QA_SCREENSHOT_DIR) return
  const originalURL = new URL(win.url())
  const originalBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  for (const [theme, width] of [['dawn', 1440], ['walnut', 920], ['dawn', 720], ['walnut', 720]]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 780), width)
    const url = new URL(originalURL)
    url.searchParams.set('theme', theme)
    await win.goto(url.href)
    await win.locator('[data-task-select]').first().waitFor({ state: 'visible' })
    await win.locator('[data-task-select]').first().click()
    if (state === 'paused') {
      await openDownloadSettings(win)
      const schedule = win.locator('[data-inspector-schedule]').getByRole('button', { name: '稍后开始', exact: true })
      await schedule.scrollIntoViewIfNeeded()
      const box = await schedule.boundingBox()
      const height = await win.evaluate(() => innerHeight)
      if (!box || box.y < 0 || box.y + box.height > height) throw new Error('Appointment control clipped in actual window')
    }
    const report = await win.evaluate(() => ({
      width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
      overflow: document.documentElement.scrollWidth > innerWidth,
      countLayers: [...document.querySelectorAll('[data-animated-count]')].map(node => node.querySelectorAll('[data-count-current]').length),
      actionIconLayers: [...document.querySelectorAll('[data-transfer-action-icon]')].map(node => node.querySelectorAll('svg').length),
      confettiCanvases: document.querySelectorAll('canvas.completion-confetti').length
    }))
    if (report.overflow || report.countLayers.some(n => n !== 1) || report.actionIconLayers.some(n => n !== 1) || report.confettiCanvases) throw new Error(JSON.stringify(report))
    console.log('real window variant:', JSON.stringify({ state, ...report }))
    await captureQAScreenshot(win, `real-${state}-${theme}-${width}`)
  }
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), originalBounds)
  await win.goto(originalURL.href)
  await win.locator('[data-task-select]').first().waitFor({ state: 'visible' })
  await win.locator('[data-task-select]').first().click()
  if (state === 'paused') await openDownloadSettings(win)
}
