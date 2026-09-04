import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

let markProbeRequested
const probeRequested = new Promise((resolve) => { markProbeRequested = resolve })
const server = createServer((_req, res) => {
  markProbeRequested()
  // Deliberately keep yt-dlp inside a real probe until the isolated Host dies.
  res.on('close', () => undefined)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('probe QA server did not expose a TCP port')

const options = qaLaunchOptions('probe-failure')
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

  await win.keyboard.press('Meta+n')
  const input = win.getByPlaceholder(/粘贴下载链接/)
  await input.fill(`http://127.0.0.1:${address.port}/watch`)
  await win.waitForTimeout(750)
  console.log(JSON.stringify({
    inputValue: await input.inputValue(),
    engineStatus: await win.evaluate(async () => await window.ndm.status()),
    composerText: await win.getByRole('dialog').textContent().catch(() => null)
  }))
  await win.getByText('正在解析清晰度与音视频轨…', { exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 })
  await Promise.race([
    probeRequested,
    new Promise((_, reject) => setTimeout(() => reject(new Error('yt-dlp never reached the hanging probe page')), 15_000))
  ])

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live', undefined, { timeout: 15_000 })

  const status = win.locator('#composer-probe-status')
  await status.waitFor({ state: 'visible', timeout: 15_000 })
  if (!await status.textContent().then((text) => text?.includes('未能分析这个链接'))) {
    throw new Error('probe failure did not explain the engine problem')
  }
  if (await input.getAttribute('aria-describedby') !== 'composer-probe-status') {
    throw new Error('probe failure was not associated with the URL field')
  }
  if (await win.getByText('正在解析清晰度与音视频轨…', { exact: true }).count() !== 0) {
    throw new Error('media probe stayed busy after failure')
  }

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-probe-failure.png'
  await win.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)
  console.log(JSON.stringify({
    interruptedProbe: {
      probeRequestObserved: true,
      isolatedHostPID: isolatedHost.pid,
      stoppedBusyState: true,
      keptComposerOpen: true,
      accessibleError: true,
      screenshotPath
    },
    rendererErrors
  }))
} finally {
  await app?.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

async function waitForLive(win) {
  await win.waitForFunction(async () => {
    if (await window.ndm?.status() !== 'live') return false
    try { return (await window.ndm.request('ping'))?.ok === true } catch { return false }
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
    const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (listeners.includes(`:${port} (LISTEN)`)) return { pid, parentPID: candidateParent }
  }
  throw new Error(`isolated NDMHost child not found for Electron PID ${parentPID} on port ${port}`)
}
