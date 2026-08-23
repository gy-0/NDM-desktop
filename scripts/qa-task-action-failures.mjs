import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filename = 'ndm-task-action-failure.bin'
const options = qaLaunchOptions('task-action-failures')
const rendererErrors = []
let app

try {
  app = await electron.launch(options)
  const win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  win.on('pageerror', (error) => rendererErrors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await waitForLive(win)

  const reply = await win.evaluate(async (targetFilename) => {
    return await window.ndm.request('add', {
      url: 'https://example.com/ndm-task-action-failure.bin',
      filename: targetFilename,
      autoStart: false
    })
  }, filename)
  if (!reply?.task?.id) throw new Error(`QA task was not created: ${JSON.stringify(reply)}`)
  const taskText = win.getByText(filename, { exact: true })
  await taskText.waitFor({ state: 'visible' })

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live', undefined, { timeout: 15_000 })

  const taskRow = win.locator('li').filter({ hasText: filename }).first()
  await taskRow.hover()
  await taskRow.getByTitle('继续', { exact: true }).click()
  await expectTaskError(win, filename)
  await dismissTaskError(win)

  const rowButton = win.getByRole('button', { name: new RegExp(escapeRegExp(filename)) }).first()
  await rowButton.click()
  const inspector = win.locator('aside').filter({ hasText: filename })
  await inspector.getByRole('button', { name: '继续', exact: true }).click()
  await expectTaskError(win, filename)
  await dismissTaskError(win)

  await win.keyboard.press('Enter')
  await expectTaskError(win, filename)
  await dismissTaskError(win)

  await rowButton.click({ button: 'right' })
  await win.getByText('继续下载', { exact: true }).click()
  await expectTaskError(win, filename)

  if (await taskText.count() === 0) throw new Error('failed task action hid the task')
  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-task-action-error.png'
  await win.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    disconnectedTaskActions: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      entryPoints: ['row', 'inspector', 'keyboard', 'context-menu'],
      keptTaskVisible: true,
      accessibleError: true,
      dismissibleError: true,
      screenshotPath
    },
    rendererErrors
  }))
} finally {
  await app?.close().catch(() => {})
}

async function expectTaskError(win, targetFilename) {
  const status = win.locator('#task-action-status')
  await status.waitFor({ state: 'visible' })
  await win.waitForFunction(
    (name) => {
      const text = document.querySelector('#task-action-status')?.textContent ?? ''
      return text.includes('未能继续') && text.includes(name) && text.includes('请检查下载引擎后重试')
    },
    targetFilename,
    { timeout: 10_000 }
  )
}

async function dismissTaskError(win) {
  await win.getByRole('button', { name: '关闭任务操作提示' }).click()
  await win.locator('#task-action-status').waitFor({ state: 'detached' })
}

async function waitForLive(win) {
  await win.waitForFunction(async () => {
    if (await window.ndm?.status() !== 'live') return false
    try {
      return (await window.ndm.request('ping'))?.ok === true
    } catch {
      return false
    }
  }, undefined, { timeout: 15_000 })
}

function findIsolatedHost(parentPID, port) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  for (const row of rows.split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const candidateParent = Number(match[2])
    const command = match[3]
    if (candidateParent !== parentPID || !command.includes('/NDMHost')) continue
    if (command.includes('/Applications/NDM.app/')) throw new Error(`refusing to touch production host: ${row}`)
    const listeners = execFileSync('/usr/sbin/lsof', [
      '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN'
    ], { encoding: 'utf8' })
    if (!listeners.includes(`:${port} (LISTEN)`)) continue
    return { pid, parentPID: candidateParent, command }
  }
  throw new Error(`isolated NDMHost child not found for Electron PID ${parentPID} on port ${port}`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
