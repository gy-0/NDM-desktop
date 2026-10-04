import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { captureQAScreenshot, closeQAApp, completeOnboarding, isolateQAClipboard, qaLaunchOptions, waitForAsyncState } from './qa-env.mjs'

const reportedURL = 'https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf?download=true&utm_source=chatgpt.com'
const filename = 'ndm-model-artifact-qa.gguf'
const payload = Buffer.alloc(1024 * 1024, 0x47)
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
  response.end(request.method === 'HEAD' ? undefined : body)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('ordinary-file QA server has no TCP port')
const localURL = `http://127.0.0.1:${address.port}/${filename}`
const launchOptions = qaLaunchOptions('ordinary-file')
const qaRoot = dirname(launchOptions.env.NDM_SUPPORT_DIR)
const downloads = `${qaRoot}/downloads`
mkdirSync(downloads, { recursive: true })

let app
let win
const rendererErrors = []

async function assertOrdinaryComposer(input, url) {
  await input.fill(url)
  await win.waitForTimeout(900)
  const composerText = await input.locator('xpath=ancestor::form').textContent()
  for (const forbidden of ['正在读取视频信息', '正在解析清晰度', '选择清晰度', '兼容优先', '体积更小']) {
    if (composerText?.includes(forbidden)) throw new Error(`ordinary file entered media UI: ${forbidden}`)
  }
}

async function waitForTaskStatus(status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastTasks = []
  while (Date.now() < deadline) {
    lastTasks = await win.evaluate(async () => (await window.ndm.request('list')).tasks ?? [])
    const match = lastTasks.find((task) => task.filename === filename && task.status === status)
    if (match) return match
    await win.waitForTimeout(200)
  }
  throw new Error(`GGUF task did not reach ${status}: ${JSON.stringify(lastTasks)}`)
}

try {
  app = await electron.launch(launchOptions)
  win = await app.firstWindow()
  await isolateQAClipboard(app)
  win.setDefaultTimeout(8000)
  win.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  win.on('pageerror', (error) => rendererErrors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await waitForAsyncState(win, async () => {
    if (await window.ndm?.status() !== 'live') return false
    try { return (await window.ndm.request('ping'))?.ok === true } catch { return false }
  }, undefined, { timeout: 15_000 })
  await win.evaluate(async (downloadDirectory) => {
    await window.ndm.request('updateSettings', { downloadDirectory, maxConnections: 2 })
  }, downloads)

  await win.getByRole('button', { name: /添加下载/ }).first().click()
  const input = win.getByRole('textbox', { name: '下载链接', exact: true })
  await assertOrdinaryComposer(input, reportedURL)
  await assertOrdinaryComposer(input, localURL)
  if (process.env.NDM_QA_STALLED_CIPHER === '1') {
    await app.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = () => new Promise(() => {})
    })
    const started = Date.now()
    await win.getByRole('button', { name: '开始下载', exact: true }).click()
    await win.locator('[data-draft-error]').waitFor({ state: 'visible', timeout: 15000 })
    await win.waitForFunction(() => {
      const field = document.querySelector('[aria-label="下载链接"]')
      return field && !field.disabled
    }, undefined, { timeout: 2000 })
    await win.waitForFunction(() => {
      const retry = document.querySelector('[data-draft-retry]')
      return retry && !retry.disabled && retry.textContent.includes('重试保存')
    }, undefined, { timeout: 2000 })
    await win.waitForTimeout(800)
    if (!await win.locator('[data-draft-retry]').isEnabled()) throw new Error('Automatic saving restarted after a secure-storage failure')
    const elapsedMs = Date.now() - started
    const tasks = await win.evaluate(async () => (await window.ndm.request('list')).tasks ?? [])
    if (tasks.length || existsSync(`${launchOptions.env.NDM_SUPPORT_DIR}/composer-draft.enc`)) throw new Error('A stalled cipher must neither submit nor persist plaintext')
    if (!await input.isEnabled() || elapsedMs > 14000) throw new Error('Composer did not recover promptly from stalled secure storage')
    if (await win.locator('[data-draft-error]').count() !== 1 || await win.locator('[data-draft-retry]').count() !== 1) throw new Error('Secure storage recovery feedback must have one explanation and retry')
    await captureQAScreenshot(win, 'real-packaged-secure-storage-timeout')
    console.log(JSON.stringify({ syntheticCipherStall: true, elapsedMs, taskCount: tasks.length, plaintextWritten: false, inputEnabled: true, error: await win.locator('[data-draft-error]').innerText() }))
    // The unsaved synthetic item belongs only to this QA profile.
  } else {
  if (process.env.NDM_QA_DIRECT_ADD === '1') {
    // Ad-hoc test identities may require interactive OS Keychain approval.
    // Keep engine QA independent of that approval; do not fake encryption.
    await win.keyboard.press('Escape')
    await win.evaluate(async (url) => {
      const reply = await window.ndm.request('add', { url })
      if (!reply.ok) throw new Error(reply.error || 'host rejected the file')
    }, localURL)
  } else {
    await win.getByRole('button', { name: '开始下载', exact: true }).click()
  }

  const task = await waitForTaskStatus('complete', 20_000)
  if (task.fileSize !== payload.length || task.completedBytes !== payload.length || task.mediaOptions) {
    throw new Error(`ordinary GGUF task is inconsistent: ${JSON.stringify(task)}`)
  }
  const finalBytes = readFileSync(join(task.folderPath, task.filename))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const sha256 = digest(finalBytes)
  if (finalBytes.length !== payload.length || sha256 !== digest(payload)) throw new Error('GGUF output bytes mismatch')
  await captureQAScreenshot(win, 'real-packaged-ordinary-complete')
  await win.evaluate(async (taskID) => {
    await window.ndm.request('remove', { taskID, deleteFile: true })
  }, task.id)
  if (rendererErrors.length) throw new Error(`renderer errors: ${rendererErrors.join(' | ')}`)
  console.log(JSON.stringify({
    creationPath: process.env.NDM_QA_DIRECT_ADD === '1' ? 'real-host-ipc' : 'composer-submit',
    reportedURLBypassedMediaUI: true,
    localGGUFDownloaded: true,
    bytes: task.completedBytes,
    sha256,
    mediaOptions: task.mediaOptions ?? null,
    rendererErrors
  }))
  }
} catch (error) {
  console.error(error)
  throw error
} finally {
  await closeQAApp(app)
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  if (existsSync(qaRoot)) {
    const trashed = spawnSync('/usr/bin/trash', [qaRoot], { encoding: 'utf8' })
    if (trashed.status !== 0) throw new Error(`failed to trash QA root: ${trashed.stderr || trashed.stdout}`)
  }
}
