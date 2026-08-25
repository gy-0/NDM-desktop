import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('completion'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
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
  openAction: await bar.getByRole('button', { name: '打开文件' }).isVisible(),
  appFocused: await win.evaluate(() => document.hasFocus()),
  confettiSurface
}

writeFileSync('/tmp/ndm-completion.png', await win.screenshot())
await bar.getByRole('button', { name: '关闭完成提示' }).click()
await bar.waitFor({ state: 'detached', timeout: 2_000 })
const completedRow = win.locator('[data-task-state="complete"]').filter({ hasText: task.filename })
await completedRow.click()
const directTargets = {
  source: await win.getByRole('button', { name: '在浏览器中打开来源网页' }).isVisible(),
  download: await win.getByRole('button', { name: '在浏览器中打开下载链接' }).isVisible(),
  storage: await win.getByRole('button', { name: '在访达中显示存储位置' }).isVisible()
}
await win.getByRole('button', { name: '在浏览器中打开来源网页' }).hover()
writeFileSync('/tmp/ndm-inspector-direct-targets.png', await win.screenshot())
console.log(JSON.stringify({ state, dismissed: true, directTargets, issues }))
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
  !directTargets.source ||
  !directTargets.download ||
  !directTargets.storage ||
  issues.length > 0
) process.exitCode = 1
