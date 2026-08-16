import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const payload = Buffer.alloc(1024 * 1024, 0x4e)
let allowSuccess = false
const server = createServer((request, response) => {
  if (!allowSuccess) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found during first attempt')
    return
  }

  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  response.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  response.end(request.method === 'HEAD' ? undefined : body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0

const app = await electron.launch(qaLaunchOptions('failure-visibility'))
let win
try {
  win = await app.firstWindow()
  const issues = []
  win.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
  })
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
    timeout: 15_000
  })

  await win.keyboard.press('Meta+n')
  await win.getByPlaceholder(/粘贴下载链接/).fill(`http://127.0.0.1:${port}/ndm-failure-qa.bin`)
  await win.keyboard.press('Enter')

  const failed = await waitForTask(win, (task) => task.status === 'error')
  const failedRow = win.locator('[data-task-state="error"]').filter({ hasText: 'ndm-failure-qa.bin' })
  try {
    await failedRow.waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    const renderer = await win.evaluate(() => ({
      states: [...document.querySelectorAll('[data-task-state]')].map((row) => ({
        state: row.getAttribute('data-task-state'),
        text: row.textContent?.slice(0, 180)
      })),
      body: document.body.innerText.slice(0, 1_200)
    }))
    throw new Error(`Host failed but renderer did not expose the error row: ${JSON.stringify({ failed, renderer })}`, { cause: error })
  }
  const failureText = (await failedRow.textContent()) ?? ''
  if (!failureText.includes('失败')) throw new Error(`failure state is not explained: ${failureText}`)

  allowSuccess = true
  await failedRow.hover()
  await failedRow.getByRole('button', { name: '重试下载' }).click()
  const completed = await waitForTask(win, (task) => task.status === 'complete')
  const completedRow = win.locator('[data-task-state="complete"]').filter({ hasText: 'ndm-failure-qa.bin' })
  await completedRow.waitFor({ state: 'visible', timeout: 10_000 })

  console.log(JSON.stringify({
    failed: { id: failed.id, status: failed.status, diagnostic: failed.diagnostic },
    completed: { id: completed.id, status: completed.status, completedBytes: completed.completedBytes },
    failureVisible: true,
    retryUsedSameTask: completed.id === failed.id,
    issues
  }))
} finally {
  if (win) {
    await win.evaluate(async () => {
      const reply = await window.ndm?.request('list')
      const targets = (reply?.tasks ?? []).filter((task) => String(task.filename).includes('ndm-failure-qa'))
      for (const task of targets) {
        await window.ndm?.request('remove', { taskID: task.id, deleteFile: true })
      }
    }).catch(() => {})
  }
  await app.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

async function waitForTask(win, predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await win.evaluate(async () => {
      const reply = await window.ndm?.request('list')
      return (reply?.tasks ?? []).find((item) => String(item.filename).includes('ndm-failure-qa'))
    }).catch(() => null)
    if (task && predicate(task)) return task
    await win.waitForTimeout(250)
  }
  throw new Error('failure QA task did not reach the expected state')
}
