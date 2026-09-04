import { _electron as electron } from 'playwright'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const launchOptions = qaLaunchOptions('completion')
const userDataArgument = launchOptions.args.find((argument) => argument.startsWith('--user-data-dir='))
if (!userDataArgument) throw new Error('QA launch is missing its isolated user-data directory')
const userDataPath = userDataArgument.slice('--user-data-dir='.length)
const app = await electron.launch(launchOptions)
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
if (process.env.NDM_QA_THEME) {
  const themedUrl = new URL(win.url())
  themedUrl.searchParams.set('theme', process.env.NDM_QA_THEME)
  await win.goto(themedUrl.toString())
  await win.waitForLoadState('domcontentloaded')
}
await completeOnboarding(win)
await win.waitForFunction(
  async () => await window.ndm?.status().catch(() => 'down') === 'live',
  undefined,
  { timeout: 15_000 }
)
await win.waitForTimeout(300)
const task = {
  id: 9_001_001,
  title: 'NDM Completion QA',
  filename: 'NDM-Completion-QA.dmg',
  folderPath: '/tmp',
  url: 'https://cdn.example.com/releases/NDM-Completion-QA.dmg?signature=long-qa-value',
  pageURL: 'https://example.com/releases/ndm-completion-qa',
  source: 'example.com',
  category: 'application',
  connections: 4,
  segments: [],
  fileSize: 1024,
  completedBytes: 512,
  status: 'downloading'
}

const pushRendererSnapshot = async (snapshot) => {
  await app.evaluate(({ BrowserWindow }, nextTask) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', {
      op: 'snapshot',
      tasks: [nextTask]
    })
  }, snapshot)
}

for (let attempt = 0; attempt < 10; attempt += 1) {
  await pushRendererSnapshot(task)
  if (await win.getByText(task.filename, { exact: true }).count()) break
  await win.waitForTimeout(200)
}
await win.evaluate((snapshot) => window.ndm?.notifySnapshot?.([snapshot], true), task)
await win.waitForFunction(
  (filename) => document.body.innerText.includes(filename),
  task.filename,
  { timeout: 5_000 }
)
await win.waitForTimeout(250)
await pushRendererSnapshot({ ...task, status: 'complete', completedBytes: 1024 })
await win.evaluate(
  (snapshot) => window.ndm?.notifySnapshot?.([{ ...snapshot, status: 'complete', completedBytes: 1024 }], true),
  task
)

const bar = win.getByTestId('completion-bar').filter({ hasText: 'NDM-Completion-QA.dmg' })
await bar.waitFor({ state: 'visible', timeout: 5_000 })
await win.locator('[data-task-state="complete"]').filter({ hasText: task.filename }).waitFor({ state: 'visible', timeout: 5_000 })
await win.waitForTimeout(120)
const confettiSurface = await win.getByTestId('completion-confetti').evaluate((canvas) => {
  const rect = canvas.getBoundingClientRect()
  return {
    parent: canvas.parentElement?.tagName,
    width: rect.width,
    height: rect.height,
    backingWidth: canvas.width,
    backingHeight: canvas.height,
    fires: Number(canvas.dataset.confettiFires ?? 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    position: getComputedStyle(canvas).position,
    pointerEvents: getComputedStyle(canvas).pointerEvents
  }
})
const state = {
  filename: await bar.getByText('NDM-Completion-QA.dmg').isVisible(),
  revealAction: await bar.getByRole('button', { name: '在访达中显示' }).isVisible(),
  installAction: await bar.getByRole('button', { name: '安装到应用程序' }).isVisible(),
  appFocused: await win.evaluate(() => document.hasFocus()),
  confettiSurface
}

writeFileSync('/tmp/ndm-completion.png', await win.screenshot())
await bar.getByRole('button', { name: '安装到应用程序' }).click()
await bar.getByText('文件不存在', { exact: true }).waitFor({ state: 'visible', timeout: 2_000 })
state.inlineInstallFailure = await bar.getByText('安装未开始', { exact: true }).isVisible()
state.inlineInstallRetry = await bar.getByRole('button', { name: '重试' }).isVisible()
await bar.evaluate((node) => { node.dataset.qaPersistentSurface = 'completion-to-install' })
const sendInstallProgress = async (phase, detail) => {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', {
      op: 'installProgress',
      path: payload.path,
      phase: payload.phase,
      detail: payload.detail
    })
  }, { path: `${task.folderPath}/${task.filename}`, phase, detail })
}
await sendInstallProgress('preparing', '正在检查磁盘映像')
const installJourney = win.getByTestId('install-progress')
await installJourney.waitFor({ state: 'visible', timeout: 2_000 })
const journeyRow = win.locator('[data-task-state="complete"]').filter({ hasText: task.filename })
const journeyState = {
  sameSurface: await installJourney.evaluate((node) => node.dataset.qaPersistentSurface === 'completion-to-install'),
  preparing: await installJourney.getByText('准备安装', { exact: true }).isVisible(),
  oneSurface: await win.locator('[data-activity-path]').count() === 1,
  indicator: await installJourney.locator('[data-install-indicator]').isVisible(),
  rowBusy: await journeyRow.getByText('安装中', { exact: true }).first().isVisible(),
  rowActionDisabled: await journeyRow.locator('[data-install-action]').isDisabled()
}
await sendInstallProgress('copying', '正在复制 NDM Completion QA')
await win.locator('[data-testid="install-progress"][data-activity-phase="copying"]').waitFor({ state: 'visible', timeout: 2_000 })
journeyState.copying = await installJourney.getByText('正在安装到“应用程序”', { exact: true }).isVisible()
await sendInstallProgress('failed', '测试安装失败，可安全重试')
await win.locator('[data-testid="install-progress"][data-activity-phase="failed"]').waitFor({ state: 'visible', timeout: 2_000 })
journeyState.failureDetail = await installJourney.getByText('测试安装失败，可安全重试', { exact: true }).isVisible()
journeyState.retryAction = await installJourney.getByRole('button', { name: '重试安装' }).isVisible()
journeyState.indicatorRemoved = await installJourney.locator('[data-install-indicator]').count() === 0
journeyState.rowFailure = await journeyRow.getByText('安装失败', { exact: true }).isVisible()
journeyState.rowRetry = await journeyRow.getByRole('button', { name: /测试安装失败，可安全重试，重试安装/ }).isVisible()
await win.waitForTimeout(220)
writeFileSync('/tmp/ndm-install-journey-failure.png', await win.screenshot())
await installJourney.getByRole('button', { name: '关闭安装提示' }).click()
await installJourney.waitFor({ state: 'detached', timeout: 2_000 })
const completedRow = win.locator('[data-task-state="complete"]').filter({ hasText: task.filename })
const installAction = completedRow.locator('[data-install-action]')
await installAction.waitFor({ state: 'visible', timeout: 2_000 })
const restingInstallActionStyle = await installAction.evaluate((button) => {
  const toolbar = button.parentElement
  const style = toolbar ? getComputedStyle(toolbar) : null
  return { opacity: style?.opacity, pointerEvents: style?.pointerEvents }
})
await completedRow.locator('[data-task-title]').hover()
await win.waitForTimeout(140)
const rowInstallState = {
  availableStatus: await completedRow.getByText('可安装', { exact: true }).isVisible(),
  installAction: await installAction.isVisible(),
  restingActionStyle: restingInstallActionStyle,
  actionVisual: await installAction.evaluate((button) => {
    const style = getComputedStyle(button)
    return { backgroundColor: style.backgroundColor, color: style.color }
  }),
  installActionStyle: await installAction.evaluate((button) => {
    const toolbar = button.parentElement
    const style = toolbar ? getComputedStyle(toolbar) : null
    return {
      opacity: style?.opacity,
      pointerEvents: style?.pointerEvents
    }
  })
}
await completedRow.click()
const directTargets = {
  source: await win.getByRole('button', { name: '在浏览器中打开来源网页' }).isVisible(),
  download: await win.getByRole('button', { name: '在浏览器中打开下载链接' }).isVisible(),
  storage: await win.getByRole('button', { name: '在访达中显示存储位置' }).isVisible()
}
const inspector = win.locator('aside').filter({ hasText: task.filename })
await inspector.getByRole('button', { name: '安装', exact: true }).click()
await inspector.locator('[data-inspector-install-error]').getByText('文件不存在', { exact: true }).waitFor({ state: 'visible', timeout: 2_000 })
const inspectorInstallState = {
  error: await inspector.locator('[data-inspector-install-error]').isVisible(),
  retry: await inspector.getByRole('button', { name: '重试', exact: true }).isVisible()
}
await win.getByRole('button', { name: '在浏览器中打开来源网页' }).hover()
writeFileSync('/tmp/ndm-inspector-direct-targets.png', await win.screenshot())
await completedRow.locator('[data-task-title]').hover()
await installAction.click()
await completedRow.getByText('安装失败', { exact: true }).waitFor({ state: 'visible', timeout: 2_000 })
const rowFailureState = {
  status: await completedRow.getByText('安装失败', { exact: true }).isVisible(),
  retryAction: await completedRow.getByRole('button', { name: '文件不存在，重试安装' }).isVisible()
}
writeFileSync('/tmp/ndm-install-row-failure.png', await win.screenshot())
const sourcePath = `${task.folderPath}/${task.filename}`
const installedPath = `${userDataPath}/NDM Completion QA.app`
const receiptKey = createHash('sha256').update(sourcePath).digest('hex')
const receiptDirectory = `${userDataPath}/installer-receipts`
mkdirSync(installedPath, { recursive: true })
mkdirSync(receiptDirectory, { recursive: true })
writeFileSync(`${receiptDirectory}/${receiptKey}.json`, JSON.stringify({
  sourcePath,
  installedPath,
  appName: 'NDM Completion QA.app',
  updatedAt: Date.now()
}))
copyFileSync('build/ndm-icon.png', `${receiptDirectory}/${receiptKey}.png`)
await app.evaluate(({ BrowserWindow }, paths) => {
  BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', {
    op: 'installProgress',
    path: paths.sourcePath,
    phase: 'complete',
    installedPath: paths.installedPath
  })
}, { sourcePath, installedPath })
await completedRow.getByText('已安装', { exact: true }).waitFor({ state: 'visible', timeout: 3_000 })
const installedCard = win.locator('[data-testid="install-progress"][data-activity-phase="complete"]')
await installedCard.waitFor({ state: 'visible', timeout: 3_000 })
const openInstalledAction = completedRow.locator('[data-completion-action="open"]')
await completedRow.locator('[data-task-title]').hover()
await win.waitForTimeout(140)
const rowInstalledState = {
  status: await completedRow.getByText('已安装', { exact: true }).isVisible(),
  openAction: await openInstalledAction.isVisible(),
  label: await openInstalledAction.textContent(),
  actionStyle: await openInstalledAction.evaluate((button) => {
    const toolbar = button.parentElement
    const style = toolbar ? getComputedStyle(toolbar) : null
    return {
      opacity: style?.opacity,
      pointerEvents: style?.pointerEvents
    }
  })
}
const confettiAfterInstall = await win.getByTestId('completion-confetti').evaluate((canvas) => ({
  active: canvas.dataset.confettiActive,
  clears: Number(canvas.dataset.confettiClears ?? 0)
}))
const installedCardState = {
  title: await installedCard.getByText('安装完成', { exact: true }).isVisible(),
  openAction: await installedCard.getByRole('button', { name: '打开应用' }).isVisible(),
  revealAction: await installedCard.getByRole('button', { name: '在访达中显示' }).isVisible(),
  oneSurface: await win.locator('[data-activity-path]').count() === 1,
  inspectorOpen: await inspector.getByRole('button', { name: '打开', exact: true }).isVisible(),
  inspectorErrorCleared: await inspector.locator('[data-inspector-install-error]').count() === 0
}
writeFileSync('/tmp/ndm-install-row-complete.png', await win.screenshot())
console.log(JSON.stringify({ state, journeyState, dismissed: true, rowInstallState, rowFailureState, inspectorInstallState, rowInstalledState, installedCardState, confettiAfterInstall, directTargets, issues }))
await app.close()

if (
  confettiSurface.parent !== 'BODY' ||
  confettiSurface.width !== confettiSurface.viewportWidth ||
  confettiSurface.height !== confettiSurface.viewportHeight ||
  confettiSurface.backingWidth !== confettiSurface.viewportWidth ||
  confettiSurface.backingHeight !== confettiSurface.viewportHeight ||
  confettiSurface.fires !== 1 ||
  confettiSurface.position !== 'fixed' ||
  confettiSurface.pointerEvents !== 'none' ||
  !state.installAction ||
  !state.inlineInstallFailure ||
  !state.inlineInstallRetry ||
  !journeyState.sameSurface ||
  !journeyState.preparing ||
  !journeyState.copying ||
  !journeyState.oneSurface ||
  !journeyState.indicator ||
  !journeyState.rowBusy ||
  !journeyState.rowActionDisabled ||
  !journeyState.failureDetail ||
  !journeyState.retryAction ||
  !journeyState.indicatorRemoved ||
  !journeyState.rowFailure ||
  !journeyState.rowRetry ||
  !rowInstallState.availableStatus ||
  !rowInstallState.installAction ||
  rowInstallState.restingActionStyle.opacity !== '0' ||
  rowInstallState.restingActionStyle.pointerEvents !== 'none' ||
  rowInstallState.actionVisual.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
  rowInstallState.installActionStyle.opacity !== '1' ||
  rowInstallState.installActionStyle.pointerEvents !== 'auto' ||
  !rowFailureState.status ||
  !rowFailureState.retryAction ||
  !inspectorInstallState.error ||
  !inspectorInstallState.retry ||
  !rowInstalledState.status ||
  !rowInstalledState.openAction ||
  rowInstalledState.label?.trim() !== '打开' ||
  rowInstalledState.actionStyle.opacity !== '1' ||
  rowInstalledState.actionStyle.pointerEvents !== 'auto' ||
  !installedCardState.title ||
  !installedCardState.openAction ||
  !installedCardState.revealAction ||
  !installedCardState.oneSurface ||
  !installedCardState.inspectorOpen ||
  !installedCardState.inspectorErrorCleared ||
  confettiAfterInstall.active !== 'false' ||
  confettiAfterInstall.clears !== 1 ||
  !directTargets.source ||
  !directTargets.download ||
  !directTargets.storage ||
  issues.length > 0
) process.exitCode = 1
