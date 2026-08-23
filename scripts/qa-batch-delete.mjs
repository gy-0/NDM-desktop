import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const payload = Buffer.alloc(1024, 0x64)
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

const options = qaLaunchOptions('batch-delete')
const baseURL = `http://127.0.0.1:${address.port}/batch-delete.bin`
const successNames = ['ndm-batch-delete-success-a.bin', 'ndm-batch-delete-success-b.bin']
const failureNames = ['ndm-batch-delete-failure-a.bin', 'ndm-batch-delete-failure-b.bin']
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

  for (const [index, filename] of successNames.entries()) {
    await addPausedTask(win, `${baseURL}?success=${index}`, filename)
  }

  const contextTarget = win.getByRole('button', { name: new RegExp(escapeRegExp(successNames[0])) }).first()
  await contextTarget.click({ button: 'right' })
  await win.getByText('从列表移除', { exact: true }).click()
  const cancelledDialog = win.getByRole('dialog', { name: '删除这个任务？' })
  await cancelledDialog.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  await cancelledDialog.waitFor({ state: 'detached' })
  for (const filename of successNames) {
    if (await win.getByText(filename, { exact: true }).count() === 0) {
      throw new Error('cancelling context-menu deletion removed a task')
    }
  }

  await selectTasks(win, successNames)
  await win.keyboard.press('Backspace')
  const successDialog = win.getByRole('dialog', { name: '删除这 2 个任务？' })
  await successDialog.waitFor({ state: 'visible' })
  for (const filename of successNames) {
    if (await win.getByText(filename, { exact: true }).count() === 0) {
      throw new Error('confirmation removed a task before engine acknowledgement')
    }
  }
  await successDialog.getByRole('button', { name: '仅从列表移除', exact: true }).click()
  await successDialog.waitFor({ state: 'detached' })
  await waitForTasksAbsent(win, successNames)

  for (const [index, filename] of failureNames.entries()) {
    await addPausedTask(win, `${baseURL}?failure=${index}`, filename)
  }
  await selectTasks(win, failureNames)
  await win.getByRole('button', { name: '批量删除', exact: true }).click()
  const failureDialog = win.getByRole('dialog', { name: '删除这 2 个任务？' })
  await failureDialog.waitFor({ state: 'visible' })

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live')
  const removeOnly = failureDialog.getByRole('button', { name: '仅从列表移除', exact: true })
  await removeOnly.click()
  await win.waitForFunction(() => document.querySelector('#delete-tasks-status')?.textContent?.includes('未能删除'))

  if (!await failureDialog.isVisible()) throw new Error('failed batch delete closed the confirmation dialog')
  if (await failureDialog.getAttribute('aria-busy') !== 'false') throw new Error('batch delete dialog stayed busy')
  if (await failureDialog.getAttribute('aria-describedby') !== 'delete-tasks-description delete-tasks-status') {
    throw new Error('batch delete failure was not associated with the dialog')
  }
  if (await removeOnly.isDisabled()) throw new Error('batch delete action stayed disabled')
  for (const filename of failureNames) {
    if (await win.getByText(filename, { exact: true }).count() === 0) {
      throw new Error(`failed batch delete hid ${filename}`)
    }
  }

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-batch-delete-error.png'
  await failureDialog.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    contextMenuDeleteCancelled: {
      keptRowsVisible: true,
      escapeClosedDialog: true
    },
    acknowledgedBatchDelete: {
      count: successNames.length,
      entryPoint: 'keyboard',
      keptRowsUntilConfirmation: true,
      removedAfterAcknowledgement: true
    },
    disconnectedBatchDelete: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptDialogOpen: true,
      keptRowsVisible: true,
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

async function addPausedTask(win, url, filename) {
  const reply = await win.evaluate(async ({ targetURL, targetFilename }) => {
    return await window.ndm.request('add', {
      url: targetURL,
      filename: targetFilename,
      autoStart: false
    })
  }, { targetURL: url, targetFilename: filename })
  if (!reply?.task?.id) throw new Error(`QA task was not created: ${JSON.stringify({ filename, reply })}`)
  await win.getByText(filename, { exact: true }).waitFor({ state: 'visible' })
}

async function selectTasks(win, filenames) {
  const first = win.getByRole('button', { name: new RegExp(escapeRegExp(filenames[0])) }).first()
  const second = win.getByRole('button', { name: new RegExp(escapeRegExp(filenames[1])) }).first()
  await first.click()
  await second.click({ modifiers: ['Meta'] })
  await win.getByText(`已选 ${filenames.length} 项`, { exact: true }).waitFor({ state: 'visible' })
}

async function waitForTasksAbsent(win, filenames) {
  await win.waitForFunction(async (targets) => {
    const reply = await window.ndm.request('list')
    const names = new Set((reply.tasks ?? []).map((task) => task.filename))
    return targets.every((target) => !names.has(target))
  }, filenames)
  for (const filename of filenames) {
    if (await win.getByText(filename, { exact: true }).count() !== 0) {
      throw new Error(`acknowledged batch delete left ${filename} visible`)
    }
  }
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
