import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filename = 'ndm-drop-entry-qa.bin'
const payload = Buffer.alloc(6 * 1024 * 1024, 0x44)
const server = createServer((request, response) => {
  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  let offset = 0
  let timer
  response.on('close', () => {
    if (timer) clearTimeout(timer)
  })
  const send = () => {
    if (response.destroyed || response.writableEnded) return
    if (offset >= body.length) {
      response.end()
      return
    }
    const next = Math.min(offset + 64 * 1024, body.length)
    response.write(body.subarray(offset, next))
    offset = next
    timer = setTimeout(send, 70)
  }
  send()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')
const url = `http://127.0.0.1:${address.port}/${filename}`
const launchOptions = qaLaunchOptions('drop-entry')
const qaRoot = dirname(launchOptions.env.NDM_SUPPORT_DIR)
const downloads = `${qaRoot}/downloads`
mkdirSync(downloads, { recursive: true })

let app
let win
const consoleErrors = []

async function task() {
  return await win.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).find((item) => item.filename === target) ?? null
  }, filename)
}

async function waitForTaskStatus(status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastTasks = []
  while (Date.now() < deadline) {
    lastTasks = await win.evaluate(async () => {
      const reply = await window.ndm?.request('list')
      return reply?.tasks ?? []
    })
    const match = lastTasks.find((item) => item.filename === filename && item.status === status)
    if (match) return match
    await win.waitForTimeout(200)
  }
  throw new Error(`task did not reach ${status}: ${JSON.stringify(lastTasks)}`)
}

async function cleanupTask() {
  if (!win) return
  await win.evaluate(async (target) => {
    const reply = await window.ndm?.request('list')
    for (const item of (reply?.tasks ?? []).filter((candidate) => candidate.filename === target)) {
      await window.ndm?.request('remove', { taskID: item.id, deleteFile: true })
    }
  }, filename).catch(() => {})
}

try {
  app = await electron.launch(launchOptions)
  win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await win.waitForFunction(
    () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('没有下载'),
    undefined,
    { timeout: 15_000 }
  )
  await completeOnboarding(win, { exerciseAllSteps: true })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await win.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') break
    if (attempt === 59) throw new Error('engine did not become live')
    await win.waitForTimeout(250)
  }
  await win.evaluate(async ({ downloadDirectory }) => {
    await window.ndm?.request('updateSettings', { downloadDirectory, maxConnections: 2 })
  }, { downloadDirectory: downloads })

  const surface = win.locator('#root > div').first()
  const localFileTransfer = await win.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['already local'], 'already-local.mp4', { type: 'video/mp4' }))
    return transfer
  })
  await surface.dispatchEvent('dragenter', { dataTransfer: localFileTransfer })
  await win.getByText('请拖入下载链接', { exact: true }).waitFor({ state: 'visible' })
  await surface.dispatchEvent('drop', { dataTransfer: localFileTransfer })
  await win.getByRole('status').getByText('本地文件已经在这台 Mac 上，NDM 不会复制或上传它', { exact: true })
    .waitFor({ state: 'visible' })
  await localFileTransfer.dispose()

  const linkTransfer = await win.evaluateHandle((target) => {
    const transfer = new DataTransfer()
    transfer.setData('text/uri-list', target)
    transfer.setData('text/plain', target)
    return transfer
  }, url)
  await surface.dispatchEvent('dragenter', { dataTransfer: linkTransfer })
  await win.getByText('释放以检查下载', { exact: true }).waitFor({ state: 'visible' })
  await surface.dispatchEvent('drop', { dataTransfer: linkTransfer })
  await linkTransfer.dispose()

  const input = win.locator('input[placeholder*="下载链接"]')
  await input.waitFor({ state: 'visible' })
  if (await input.inputValue() !== url) throw new Error(`drop did not prefill the composer: ${await input.inputValue()}`)
  if (await task()) throw new Error('drop started a task before the user confirmed it')
  console.log('drop review gate:', JSON.stringify({ prefilled: true, taskBeforeConfirmation: false }))

  await win.getByRole('button', { name: '开始下载', exact: true }).click()
  await waitForTaskStatus('downloading', 10_000)
  const completed = await waitForTaskStatus('complete', 30_000)
  if (completed.completedBytes !== payload.length || completed.fileSize !== payload.length) {
    throw new Error(`downloaded byte count is inconsistent: ${JSON.stringify(completed)}`)
  }
  console.log('drop download:', JSON.stringify({ status: completed.status, bytes: completed.completedBytes }))

  await cleanupTask()
  console.log('qa task cleanup:', await task() == null)
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : 'none')
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`)
} finally {
  await cleanupTask()
  await app?.close().catch(() => {})
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  if (existsSync(qaRoot)) {
    const trashed = spawnSync('/usr/bin/trash', [qaRoot], { encoding: 'utf8' })
    if (trashed.status !== 0) {
      throw new Error(`failed to move QA root to Trash: ${trashed.stderr || trashed.stdout}`)
    }
  }
}

console.log('DONE')
