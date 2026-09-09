import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const launch = qaLaunchOptions('live-recording')
delete launch.env.ELECTRON_RUN_AS_NODE
const root = launch.env.NDM_SUPPORT_DIR
const media = join(root, 'fixture')
const output = join(root, 'downloads')
mkdirSync(media, { recursive: true })
mkdirSync(output, { recursive: true })
const ffmpeg = join(process.cwd(), 'native/Vendor/Tools/ffmpeg')
const generated = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=128x72:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-g', '10', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', join(media, 'live.m3u8')], { encoding: 'utf8' })
assert.equal(generated.status, 0, generated.stderr)
const server = createServer((req, res) => {
  const file = join(media, basename(new URL(req.url, 'http://localhost').pathname))
  if (!existsSync(file)) { res.writeHead(404); res.end(); return }
  let body = readFileSync(file)
  if (file.endsWith('.m3u8')) body = Buffer.from(body.toString().replace('#EXT-X-ENDLIST', ''))
  res.writeHead(200, { 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', 'Content-Length': body.length })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
try {
  app = await electron.launch(launch)
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.ndm?.status().then(s => s === 'live'), undefined, { timeout: 20000 })
  await completeOnboarding(win)
  await win.waitForFunction(async () => {
    try { return (await window.ndm.request('list')).ok === true } catch { return false }
  }, undefined, { timeout: 20000 })
  const added = await win.evaluate(args => window.ndm.request('add', args), {
    url: `http://127.0.0.1:${server.address().port}/live.m3u8`, folderPath: output, filename: '直播录制测试.mp4', ltype: 'hls'
  })
  assert.equal(added.ok, true)
  const id = added.task.id
  async function waitForTask(predicate) {
    for (let i = 0; i < 200; i++) {
      const r = await win.evaluate(() => window.ndm.request('list'))
      const task = r.tasks.find(t => t.id === id)
      if (task && predicate(task)) return task
      await delay(100)
    }
    throw new Error('Timed out waiting for recording state')
  }
  await waitForTask(t => t.isLiveRecording && t.recordedDuration >= 3)
  await win.getByRole('button', { name: '停止并保存', exact: true }).first().waitFor()
  const text = await win.locator('body').innerText()
  assert.match(text, /录制/)
  await win.screenshot({ path: '/tmp/ndm-live-recording-desktop.png' })
  await win.getByRole('button', { name: '停止并保存', exact: true }).first().click()
  const final = await waitForTask(t => t.status === 'complete' && t.filename.endsWith('.mp4'))
  const file = join(final.folderPath, final.filename)
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-t', '1', '-f', 'null', '-'], { encoding: 'utf8' })
  assert.equal(decoded.status, 0, decoded.stderr)
  console.log(JSON.stringify({ passed: true, file, duration: final.recordedDuration, screenshot: '/tmp/ndm-live-recording-desktop.png' }))
} finally {
  if (app) await app.close()
  await new Promise(resolve => server.close(resolve))
}
