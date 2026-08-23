import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filename = 'ndm-task-bandwidth-failure-qa.bin'
const payload = Buffer.alloc(1024, 0x62)
const server = createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': payload.length,
    'Accept-Ranges': 'bytes'
  })
  res.end(req.method === 'HEAD' ? undefined : payload)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')

const options = qaLaunchOptions('task-adjustment-failures')
const url = `http://127.0.0.1:${address.port}/${filename}`
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

  const created = await win.evaluate(async ({ targetURL, targetFilename }) => {
    return await window.ndm.request('add', {
      url: targetURL,
      filename: targetFilename,
      autoStart: false
    })
  }, { targetURL: url, targetFilename: filename })
  if (!created?.task?.id) throw new Error(`paused QA task was not created: ${JSON.stringify(created)}`)

  await win.getByText(filename, { exact: true }).click()
  const group = win.getByRole('group', { name: '此任务限速' })
  const connectionsGroup = win.getByRole('group', { name: '任务连接数' })
  const decreaseConnections = connectionsGroup.getByRole('button', { name: '减少连接' })
  const unlimited = group.getByRole('button', { name: '不限速', exact: true })
  const fiveMegabytes = group.getByRole('button', { name: '5 MB/s', exact: true })
  await fiveMegabytes.waitFor({ state: 'visible' })
  if (await unlimited.getAttribute('aria-pressed') !== 'true') throw new Error('initial unlimited state was not selected')

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live')
  await fiveMegabytes.click()
  await win.waitForFunction(() => document.querySelector('#task-bandwidth-status')?.textContent?.includes('未能保存'))

  if (await fiveMegabytes.getAttribute('aria-pressed') !== 'false') {
    throw new Error('failed task bandwidth save changed the visible selection')
  }
  if (await unlimited.getAttribute('aria-pressed') !== 'true') {
    throw new Error('failed task bandwidth save discarded the previous selection')
  }
  if (await group.getAttribute('aria-describedby') !== 'task-bandwidth-status') {
    throw new Error('task bandwidth error was not associated with its controls')
  }
  if (await group.getAttribute('aria-busy') !== 'false') throw new Error('task bandwidth controls stayed busy')
  if (await fiveMegabytes.isDisabled()) throw new Error('task bandwidth controls stayed disabled')

  const connectionsBefore = await connectionsGroup.getAttribute('data-task-connections')
  await decreaseConnections.click()
  await win.waitForFunction(() => document.querySelector('#task-connections-status')?.textContent?.includes('未能保存'))
  if (await connectionsGroup.getAttribute('data-task-connections') !== connectionsBefore) {
    throw new Error('failed task connection save changed the visible count')
  }
  if (await connectionsGroup.getAttribute('aria-describedby') !== 'task-connections-status') {
    throw new Error('task connection error was not associated with its controls')
  }
  if (await connectionsGroup.getAttribute('aria-busy') !== 'false') throw new Error('task connection controls stayed busy')
  if (await decreaseConnections.isDisabled()) throw new Error('task connection controls stayed disabled')

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-task-adjustment-errors.png'
  await win.locator('#task-bandwidth-status').scrollIntoViewIfNeeded()
  await win.locator('aside').filter({ hasText: '任务详情' }).screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    disconnectedSave: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      preservedVisibleSelection: true,
      controlGroupReenabled: true,
      accessibleError: true,
      screenshotPath
    },
    disconnectedConnectionSave: {
      preservedVisibleCount: true,
      controlGroupReenabled: true,
      accessibleError: true
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
