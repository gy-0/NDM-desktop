// Real Electron + isolated Host; replace a local source between pause and resume.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'
const options = qaLaunchOptions('changed-download')
const gesture = process.env.NDM_QA_RECOVERY_GESTURE || 'button'
assert.ok(['button', 'enter', 'doubleClick'].includes(gesture))
const root = dirname(options.env.NDM_SUPPORT_DIR), downloads = join(root, 'downloads')
mkdirSync(downloads)
const payloads = [Buffer.alloc(4 * 1024 * 1024, 17), Buffer.alloc(4 * 1024 * 1024, 92)]
const digest = data => createHash('sha256').update(data).digest('hex')
let generation = 0, taskID, win
const server = createServer((req, res) => {
  const payload = payloads[generation]
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1,
    'accept-ranges': 'bytes', etag: `"${digest(payload)}"`, ...(range ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (req.method === 'HEAD') { res.end(); return }
  let offset = start, timer
  res.on('close', () => clearTimeout(timer))
  const send = () => {
    if (res.destroyed) return
    const next = Math.min(end + 1, offset + 32768)
    res.write(payload.subarray(offset, next)); offset = next
    if (offset > end) res.end(); else timer = setTimeout(send, generation ? 2 : 35)
  }
  send()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const app = await electron.launch(options)
async function rpc(op, args = {}) { return win.evaluate(({op, args}) => window.ndm.request(op, args), {op, args}) }
async function waitTask(predicate) {
  for (let n = 0; n < 160; n++) {
    const task = (await rpc('list')).tasks?.find(t => t.id === taskID)
    if (task && predicate(task)) return task
    await win.waitForTimeout(200)
  }
  throw new Error('Task did not reach expected state')
}
try {
  win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.waitForFunction(() => window.ndm.status().then(s => s === 'live'))
  const added = await rpc('add', { url: `http://127.0.0.1:${server.address().port}/changed-download-qa.bin`, folderPath: downloads, connections: 1 })
  taskID = added.task.id
  await waitTask(t => t.status === 'downloading' && t.completedBytes >= 65536)
  assert.equal((await rpc('pause', { taskID })).ok, true)
  const paused = await waitTask(t => t.status === 'paused')
  const receipt = JSON.parse(readFileSync(join(options.env.NDM_SUPPORT_DIR, String(taskID), 'offset-storage-v2.json'), 'utf8'))
  assert.equal(receipt.version, 2)
  assert.ok(receipt.ranges.some(range => range.durablePrefix > 0))
  generation = 1
  assert.equal((await rpc('resume', { taskID })).ok, true)
  const failed = await waitTask(t => t.status === 'error')
  assert.match(JSON.stringify(failed.diagnostic), /下载记录|download record/i)
  const row = win.locator('[data-task-state="error"]').filter({ hasText: 'changed-download-qa.bin' })
  await row.click({ button: 'right' })
  await win.getByRole('menuitem', { name: '重试下载', exact: true }).waitFor()
  assert.equal(await win.getByRole('menuitem', { name: /继续下载/ }).count(), 0)
  await win.keyboard.press('Escape')
  await row.click()
  await win.getByText('源文件或本地下载记录发生变化', { exact: false }).first().waitFor()
  const visibleFailure = await win.locator('[data-download-failure]').evaluate(el => {
    const rect = el.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= innerHeight
  })
  assert.ok(visibleFailure, 'Failure explanation must be visible without scrolling')
  const screenshot = join(root, 'failure.png'); await win.screenshot({ path: screenshot })
  if (gesture === 'enter') {
    await row.click(); await win.keyboard.press('Enter')
  } else if (gesture === 'doubleClick') {
    await row.dblclick()
  } else {
    await row.hover(); await row.getByRole('button', { name: '重试下载' }).click()
  }
  const complete = await waitTask(t => t.status === 'complete')
  assert.equal(complete.id, taskID)
  const actualHash = digest(readFileSync(join(complete.folderPath, complete.filename)))
  assert.equal(actualHash, digest(payloads[1]))
  const report = { gesture, pausedBytes: paused.completedBytes, diagnostic: failed.diagnostic, sameTask: true, actualHash, screenshot }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally {
  if (win && taskID) await rpc('remove', { taskID, deleteFile: true }).catch(() => {})
  await app.close().catch(() => {})
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
