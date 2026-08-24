import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const filename = 'ndm-completion-stack-qa.mp4'
const stem = 'ndm-completion-stack-qa'
const launchOptions = qaLaunchOptions('completion-stack')
const qaRoot = dirname(launchOptions.env.NDM_SUPPORT_DIR)
const downloads = `${qaRoot}/downloads`
const sourceDirectory = `${qaRoot}/source`
const sourcePath = `${sourceDirectory}/${filename}`
mkdirSync(downloads, { recursive: true })
mkdirSync(sourceDirectory, { recursive: true })

if (!launchOptions.executablePath) {
  throw new Error('NDM_QA_APP_PATH must point to the packaged NDM executable')
}
const contentsDirectory = dirname(dirname(launchOptions.executablePath))
const ffmpegPath = `${contentsDirectory}/Resources/Tools/ffmpeg`
const generated = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=duration=16:size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=16',
  '-c:v', 'mpeg4', '-b:v', '2M', '-c:a', 'aac',
  '-movflags', '+faststart', '-y', sourcePath
], { encoding: 'utf8' })
if (generated.status !== 0 || !existsSync(sourcePath)) {
  throw new Error(`packaged ffmpeg could not generate the QA media: ${generated.stderr || generated.stdout}`)
}
const payload = readFileSync(sourcePath)
if (payload.length < 1_000_000) throw new Error(`QA media is unexpectedly small: ${payload.length} bytes`)
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : payload.length - 1
  const body = payload.subarray(start, Math.min(end + 1, payload.length))
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {})
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  let offset = 0
  let sendTimer
  res.on('close', () => {
    if (sendTimer) clearTimeout(sendTimer)
  })
  const send = () => {
    if (res.destroyed || res.writableEnded) return
    if (offset >= body.length) {
      res.end()
      return
    }
    const next = Math.min(offset + 64 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    sendTimer = setTimeout(send, 100)
  }
  send()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('QA server did not expose a TCP port')
const url = `http://127.0.0.1:${address.port}/${filename}`

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
    const targets = (reply?.tasks ?? []).filter((item) => item.filename === target)
    for (const item of targets) {
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
    () => Boolean(document.querySelector('ul li')) || document.body.innerText.includes('暂无下载'),
    undefined,
    { timeout: 15_000 }
  )
  await completeOnboarding(win, { exerciseAllSteps: true })
  for (let i = 0; i < 60; i++) {
    if (await win.evaluate(() => window.ndm?.status()).catch(() => 'down') === 'live') break
    if (i === 59) throw new Error('engine did not become live')
    await win.waitForTimeout(250)
  }
  await win.evaluate(async ({ downloadDirectory }) => {
    await window.ndm?.request('updateSettings', { downloadDirectory, maxConnections: 2 })
  }, { downloadDirectory: downloads })

  await win.keyboard.press('Meta+n')
  await win.locator('input[placeholder*="下载链接"]').fill(url)
  await win.keyboard.press('Enter')
  await waitForTaskStatus('downloading', 10_000)

  writeFileSync(`${downloads}/${stem}.en.srt`, '1\n00:00:00,000 --> 00:00:01,000\nHello from NDM\n')
  writeFileSync(`${downloads}/${stem}.webp`, Buffer.from('qa-cover'))
  writeFileSync(`${downloads}/${stem}.txt`, 'Readable transcript')
  writeFileSync(`${downloads}/unrelated.srt`, 'This file must never join the stack')

  const completed = await waitForTaskStatus('complete', 30_000)
  if (!completed?.id) throw new Error(`completed task did not expose an id: ${JSON.stringify(completed)}`)
  if (completed.completedBytes !== completed.fileSize) {
    throw new Error(`completed task byte count is inconsistent: ${JSON.stringify(completed)}`)
  }
  const artifacts = await win.evaluate(async (taskID) => {
    const reply = await window.ndm?.request('completionStack', { taskID })
    return reply?.artifacts ?? []
  }, completed.id)
  console.log('host completion stack:', JSON.stringify(artifacts))
  if (artifacts.length !== 4 || artifacts.some((artifact) => artifact.name === 'unrelated.srt')) {
    throw new Error(`Host returned an untruthful completion stack: ${JSON.stringify(artifacts)}`)
  }

  const disclosure = win.getByRole('button', { name: '完成文件' })
  await disclosure.waitFor({ state: 'visible', timeout: 10_000 })
  if (!await win.getByText('4 个文件 · 1 份字幕', { exact: true }).isVisible()) {
    throw new Error('completion stack summary is missing or inaccurate')
  }
  await disclosure.click()
  const completionList = win.getByRole('list', { name: '完成文件列表' })
  const rows = completionList.getByRole('listitem')
  if (await rows.count() !== 4) throw new Error(`expected 4 visible completion files, got ${await rows.count()}`)
  for (const expected of [filename, `${stem}.en.srt`, `${stem}.webp`, `${stem}.txt`]) {
    if (!await completionList.getByText(expected, { exact: true }).isVisible()) {
      throw new Error(`completion file is not visible: ${expected}`)
    }
  }
  if (await completionList.getByText('unrelated.srt', { exact: true }).count()) {
    throw new Error('unrelated file leaked into the completion stack')
  }
  console.log('electron completion stack:', JSON.stringify({ expanded: true, rows: await rows.count() }))

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
