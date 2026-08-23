import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const collectionID = 'qa-local-collection'
const collectionTitle = '本地 QA 合集'
const filenames = ['01 - qa-collection-a.mp4', '02 - qa-collection-b.mp4']
const options = qaLaunchOptions('collection-actions')
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
    const postData = Buffer.from(JSON.stringify({
      container: 'compatibleMP4',
      collectionID,
      collectionTitle,
      collectionIndex: index + 1,
      collectionCount: filenames.length
    })).toString('base64')
    const reply = await win.evaluate(async ({ targetFilename, encodedOptions, suffix }) => {
      return await window.ndm.request('add', {
        url: `https://example.com/qa-collection-${suffix}.mp4`,
        filename: targetFilename,
        postData: encodedOptions,
        autoStart: false
      })
    }, { targetFilename: filename, encodedOptions: postData, suffix: index })
    if (!reply?.task?.id) throw new Error(`QA collection task was not created: ${JSON.stringify(reply)}`)
  }

  const group = win.locator(`[data-collection-group="${collectionID}"]`)
  await group.waitFor({ state: 'visible' })
  const initialTasks = await win.evaluate(async (id) => {
    const reply = await window.ndm.request('list')
    return (reply.tasks ?? []).filter((task) => task.collection?.id === id)
  }, collectionID)
  console.log('synthetic collection:', JSON.stringify(initialTasks.map((task) => ({
    filename: task.filename,
    status: task.status,
    collection: task.collection
  }))))
  const resume = group.getByRole('button', { name: '继续整个合集' })
  await resume.waitFor({ state: 'visible' })
  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live', undefined, { timeout: 15_000 })
  await resume.click()

  const statusID = `collection-action-status-${collectionID}`
  await win.waitForFunction(
    (id) => document.getElementById(id)?.textContent?.includes('未能继续整个合集'),
    statusID,
    { timeout: 10_000 }
  )
  if (await resume.isDisabled()) throw new Error('collection action stayed disabled after failure')
  if (await resume.getAttribute('aria-describedby') !== statusID) {
    throw new Error('collection failure was not associated with its action')
  }
  if (!await group.isVisible()) throw new Error('collection disappeared after failed action')

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-collection-action-error.png'
  await win.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    syntheticCollection: {
      count: initialTasks.length,
      statuses: initialTasks.map((task) => task.status)
    },
    disconnectedCollectionResume: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptGroupVisible: true,
      actionReenabled: true,
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
