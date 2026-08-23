import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filenames = ['ndm-cleanup-paused-a.bin', 'ndm-cleanup-paused-b.bin']
const options = qaLaunchOptions('cleanup-failure')
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

  for (const [index, filename] of filenames.entries()) {
    const reply = await win.evaluate(async ({ targetFilename, suffix }) => {
      return await window.ndm.request('add', {
        url: `https://example.com/ndm-cleanup-${suffix}.bin`,
        filename: targetFilename,
        autoStart: false
      })
    }, { targetFilename: filename, suffix: index })
    if (!reply?.task?.id) throw new Error(`QA task was not created: ${JSON.stringify(reply)}`)
    await win.getByText(filename, { exact: true }).waitFor({ state: 'visible' })
  }

  await win.getByRole('button', { name: /整理任务库/ }).click()
  const dialog = win.getByRole('dialog', { name: '整理任务库' })
  await dialog.waitFor({ state: 'visible' })
  const pausedBucket = dialog.locator('section[aria-labelledby="cleanup-bucket-paused-title"]')
  const remove = pausedBucket.getByRole('button', { name: '移出列表' })
  if (!await pausedBucket.getByText(String(filenames.length), { exact: true }).isVisible()) {
    throw new Error('paused cleanup bucket did not show both QA tasks')
  }

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live', undefined, { timeout: 15_000 })
  await remove.click()
  const status = pausedBucket.locator('#cleanup-bucket-paused-status')
  await status.waitFor({ state: 'visible' })
  await win.waitForFunction(
    () => document.querySelector('#cleanup-bucket-paused-status')?.textContent?.includes('未能移出已暂停任务'),
    undefined,
    { timeout: 10_000 }
  )

  if (!await dialog.isVisible()) throw new Error('failed cleanup closed the sheet')
  if (await dialog.getAttribute('aria-busy') !== 'false') throw new Error('cleanup sheet stayed busy')
  if (await remove.isDisabled()) throw new Error('cleanup action stayed disabled')
  if (await remove.getAttribute('aria-describedby') !== 'cleanup-bucket-paused-status') {
    throw new Error('cleanup error was not associated with its action')
  }
  if (!await pausedBucket.getByText(String(filenames.length), { exact: true }).isVisible()) {
    throw new Error('failed cleanup changed the paused count')
  }
  for (const filename of filenames) {
    if (await win.getByText(filename, { exact: true }).count() === 0) {
      throw new Error(`failed cleanup hid ${filename}`)
    }
  }
  const close = dialog.getByRole('button', { name: '关闭' })
  const done = dialog.getByRole('button', { name: '完成' })
  if (await close.isDisabled() || await done.isDisabled()) throw new Error('cleanup close controls stayed disabled')

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-cleanup-failure.png'
  await dialog.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    disconnectedCleanup: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptSheetOpen: true,
      keptRowsVisible: true,
      keptCount: filenames.length,
      actionReenabled: true,
      closeControlsReenabled: true,
      accessibleError: true,
      screenshotPath
    },
    rendererErrors
  }))
} finally {
  await app?.close().catch(() => {})
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
