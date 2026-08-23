import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const payload = Buffer.alloc(8 * 1024 * 1024, 0x73)
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  let offset = 0
  let timer
  res.on('close', () => {
    if (timer) clearTimeout(timer)
  })
  const send = () => {
    if (res.destroyed || res.writableEnded) return
    if (offset >= body.length) {
      res.end()
      return
    }
    const next = Math.min(offset + 32 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    timer = setTimeout(send, 40)
  }
  send()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')

const filenames = ['ndm-selected-action-a.bin', 'ndm-selected-action-b.bin']
const options = qaLaunchOptions('selected-actions')
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
    const reply = await win.evaluate(async ({ url, targetFilename }) => {
      return await window.ndm.request('add', { url, filename: targetFilename, autoStart: false })
    }, { url: `http://127.0.0.1:${address.port}/selected-${index}.bin`, targetFilename: filename })
    if (!reply?.task?.id) throw new Error(`QA task was not created: ${JSON.stringify(reply)}`)
    await win.getByText(filename, { exact: true }).waitFor({ state: 'visible' })
  }

  await selectTasks(win, filenames)
  const toolbar = win.getByRole('toolbar', { name: '批量任务操作' })
  await toolbar.getByRole('button', { name: '全部继续', exact: true }).click()
  await waitForStatuses(win, filenames, (statuses) => statuses.every((status) => status === 'downloading' || status === 'waiting'))
  await toolbar.getByRole('button', { name: '全部暂停', exact: true }).click()
  await waitForStatuses(win, filenames, (statuses) => statuses.every((status) => status === 'paused'))

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live', undefined, { timeout: 15_000 })

  const resume = toolbar.getByRole('button', { name: '全部继续', exact: true })
  await resume.click()
  const status = toolbar.locator('#batch-task-action-status')
  await status.waitFor({ state: 'visible' })
  await win.waitForFunction(
    () => document.querySelector('#batch-task-action-status')?.textContent?.includes('未能继续所选任务'),
    undefined,
    { timeout: 10_000 }
  )

  if (await toolbar.getAttribute('aria-busy') !== 'false') throw new Error('selected action toolbar stayed busy')
  if (await resume.isDisabled()) throw new Error('selected resume action stayed disabled')
  if (await resume.getAttribute('aria-describedby') !== 'batch-task-action-status') {
    throw new Error('selected action failure was not associated with its action')
  }
  if (!await win.getByText(`已选 ${filenames.length} 项`, { exact: true }).isVisible()) {
    throw new Error('failed selected action cleared the selection')
  }
  for (const filename of filenames) {
    if (await win.getByText(filename, { exact: true }).count() === 0) {
      throw new Error(`failed selected action hid ${filename}`)
    }
  }

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-selected-action-error.png'
  await win.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    acknowledgedSelectedActions: {
      resumed: filenames.length,
      paused: filenames.length
    },
    disconnectedSelectedResume: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptRowsVisible: true,
      keptSelection: filenames.length,
      actionReenabled: true,
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

async function selectTasks(win, targets) {
  const first = win.getByRole('button', { name: new RegExp(escapeRegExp(targets[0])) }).first()
  const second = win.getByRole('button', { name: new RegExp(escapeRegExp(targets[1])) }).first()
  await first.click()
  await second.click({ modifiers: ['Meta'] })
  await win.getByText(`已选 ${targets.length} 项`, { exact: true }).waitFor({ state: 'visible' })
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

async function waitForStatuses(win, targets, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const statuses = await win.evaluate(async (names) => {
      const reply = await window.ndm.request('list')
      const byName = new Map((reply.tasks ?? []).map((task) => [task.filename, task.status]))
      return names.map((name) => byName.get(name) ?? 'missing')
    }, targets)
    if (predicate(statuses)) return statuses
    await win.waitForTimeout(100)
  }
  throw new Error(`selected action statuses did not converge for ${JSON.stringify(targets)}`)
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
