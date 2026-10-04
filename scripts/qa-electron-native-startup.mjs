// Actual Electron composer -> current isolated release Host -> delayed HTTP fixture.
// Retains screenshots/report; never opens installed apps or production profiles.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { resolve, join, dirname } from 'node:path'
import { _electron } from 'playwright'
import { isolateQAClipboard, completeOnboarding } from './qa-env.mjs'

const measureCompletion = process.env.NDM_COMPLETION_FRAMES === '1'
const root = await mkdtemp('/tmp/ndm-electron-native-')
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(label, check, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50) }
  throw new Error(`Timeout: ${label}`)
}
async function freePort() {
  const s = tcpServer(); await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = s.address().port; await new Promise(r => s.close(r)); return port
}
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(16 * 1024 * 1024)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + (i >>> 16)) % 251
const received = [], pageErrors = []
const server = createServer(async (req, res) => {
  const record = { path: req.url, method: req.method, range: req.headers.range ?? null, receivedAt: Date.now() }
  received.push(record)
  await delay(150)
  if (res.destroyed) return
  if (req.url === '/expired.bin') { res.writeHead(403); res.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"electron-startup-v1"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (req.method === 'HEAD') { res.end(); return }
  record.firstBodyAt = Date.now()
  for (let offset = start; offset <= end && !res.destroyed; offset += 65536) {
    res.write(payload.subarray(offset, Math.min(offset + 65536, end + 1)))
    await delay(12)
  }
  if (!res.destroyed) res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }
const packagedExecutable = process.env.NDM_QA_APP_PATH?.trim()
const binary = packagedExecutable
  ? resolve(dirname(packagedExecutable), '../Resources/bin/NDMHost')
  : resolve('native/.build/release/NDMHost')
const host = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let hostLog = ''; host.stdout.on('data', x => { hostLog += x }); host.stderr.on('data', x => { hostLog += x })
const hostExit = once(host, 'exit')
let sequence = 0, app, win
const report = { root, packagedExecutable: packagedExecutable ?? null, binary, hostSHA256: createHash('sha256').update(await readFile(binary)).digest('hex'), received, pageErrors }
function request(op, extra = {}) {
  return new Promise((resolveReply, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port: hostPort })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`RPC ${op} timed out`)) }, 10000)
    let buffer = ''
    socket.on('error', e => { clearTimeout(timer); reject(e) })
    socket.on('connect', () => socket.write(JSON.stringify({ ...extra, id, op }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        const reply = JSON.parse(line)
        if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolveReply(reply); return }
      }
    })
  })
}
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, useCategoryFolders: false, maxConnections: 4, bandwidthLimitBytesPerSecond: 0 })).ok, true)
  app = await _electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [...(packagedExecutable ? [] : ['.']), '--mute-audio', `--user-data-dir=${join(root, 'electron')}`], env
  })
  report.app = await app.evaluate(({ app }) => ({ version: app.getVersion(), path: app.getAppPath(), packaged: app.isPackaged }))
  if (packagedExecutable) {
    assert.equal(report.app.packaged, true)
    report.app.asarSHA256 = createHash('sha256').update(await readFile(report.app.path)).digest('hex')
  }
  await isolateQAClipboard(app)
  win = await app.firstWindow()
  win.on('pageerror', error => pageErrors.push(String(error)))
  await win.getByRole('button', { name: '添加下载', exact: true }).waitFor()
  await completeOnboarding(win)
  await win.evaluate(() => document.fonts.ready)
  await win.screenshot({ path: join(root, 'ready.png') })
  async function submit(path) {
    await win.keyboard.press('Meta+n')
    const input = win.locator('input[placeholder*="粘贴文件链接"]')
    await input.fill(`${base}${path}`)
    const at = Date.now()
    await input.press('Enter')
    return at
  }
  if (measureCompletion) {
    await win.getByTestId('completion-confetti').waitFor({ state: 'attached' })
    await win.evaluate(() => {
      const state = window.__completionFrames = { gaps: [], longTasks: [], fires: [], completedAt: null }
      let last = performance.now()
      const frame = now => {
        state.gaps.push({ at: now, ms: now - last })
        last = now
        state.frame = requestAnimationFrame(frame)
      }
      state.frame = requestAnimationFrame(frame)
      state.observer = new PerformanceObserver(list => {
        state.longTasks.push(...list.getEntries().map(entry => ({ at: entry.startTime, ms: entry.duration })))
      })
      state.observer.observe({ type: 'longtask', buffered: false })
      state.mutations = new MutationObserver(records => {
        if (records.some(record => record.attributeName === 'data-confetti-fires')) state.fires.push(performance.now())
      })
      state.mutations.observe(document.querySelector('[data-testid="completion-confetti"]'), { attributes: true })
      state.unsubscribe = window.ndm.onEvent(message => {
        if (state.completedAt === null && message.op === 'snapshot' && message.tasks?.some(task => task.filename === 'startup.bin' && task.status === 'complete')) state.completedAt = performance.now()
      })
    })
  }
  report.submittedAt = await submit('/startup.bin')
  const active = await until('active task', async () => (await request('list')).tasks.find(t => t.status === 'downloading' && t.completedBytes > 0))
  report.active = active
  await win.getByText('startup.bin', { exact: true }).first().waitFor()
  await until('visible nonzero progress', async () => {
    const values = await win.getByRole('progressbar', { name: 'startup.bin 下载进度', exact: true }).evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('aria-valuenow'))))
    return values.some(value => value > 0 && value < 100)
  })
  report.submitToVisibleProgressMs = Date.now() - report.submittedAt
  await until('visible nonzero speed', async () => {
    const values = await win.locator('[data-gallery-speed]').allTextContents()
    return values.some(value => Number.parseFloat(value) > 0 && /[KMG]?B\/s/.test(value))
  })
  report.submitToVisibleSpeedMs = Date.now() - report.submittedAt
  if (!measureCompletion) await win.screenshot({ path: join(root, 'active.png') })
  const complete = await until('complete task', async () => (await request('list')).tasks.find(t => t.status === 'complete'))
  assert.equal(complete.url, `${base}/startup.bin`)
  const actual = await readFile(join(complete.folderPath, complete.filename))
  assert.deepEqual(actual, payload)
  report.sha256 = createHash('sha256').update(actual).digest('hex')
  report.complete = complete
  const requests = received.filter(r => r.path === '/startup.bin')
  report.submitToServerRequestMs = requests[0].receivedAt - report.submittedAt
  report.submitToFirstServerBodyMs = requests.find(request => request.firstBodyAt)?.firstBodyAt - report.submittedAt
  if (measureCompletion) {
    // Keep screenshots out of the measured interval: capture itself can stall rendering.
    await win.waitForFunction(() => window.__completionFrames.completedAt !== null)
    await delay(2800)
    report.completionFrames = await win.evaluate(() => {
      const s = window.__completionFrames, start = s.completedAt
      const gaps = s.gaps.filter(entry => entry.at >= start - 100 && entry.at <= start + 2500).map(entry => entry.ms).sort((a, b) => a - b)
      cancelAnimationFrame(s.frame); s.observer.disconnect(); s.mutations.disconnect(); s.unsubscribe()
      return {
        scope: 'Real composer download through isolated release Swift Host; renderer event-to-fire and rAF timing, not pixel presentation timing',
        sampleCount: gaps.length,
        maxFrameGapMS: Math.max(...gaps), p95FrameGapMS: gaps[Math.floor(gaps.length * .95)],
        framesOver50MS: gaps.filter(ms => ms > 50).length,
        slowFrames: s.gaps.filter(entry => entry.at >= start - 100 && entry.at <= start + 2500 && entry.ms > 25).map(entry => ({ afterCompletionMS: entry.at - start, gapMS: entry.ms })),
        longTasks: s.longTasks.filter(entry => entry.at + entry.ms >= start - 100 && entry.at <= start + 2500),
        fireDelayMS: s.fires.find(at => at >= start) - start,
        fires: s.fires.length
      }
    })
    report.completionFrames.workerSchemes = win.workers().map(worker => worker.url().split(':')[0])
    assert.ok(report.completionFrames.sampleCount > 30, 'Completion frame observation must contain useful samples')
    assert.equal(report.completionFrames.fires, 1, 'One real completed download must celebrate exactly once')
    assert.ok(Number.isFinite(report.completionFrames.fireDelayMS), 'Real completion must trigger fireworks')
    assert.ok(report.completionFrames.workerSchemes.includes('blob'), 'Animation worker must be running')
  }
  await delay(500)
  await win.screenshot({ path: join(root, 'complete.png') })
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].range, 'bytes=0-')
  assert.ok(!requests.some(r => r.method === 'HEAD' || r.range === 'bytes=0-0'), 'Composer must not reintroduce a metadata probe')
  await submit('/expired.bin')
  report.failed = await until('HTTP failure', async () => (await request('list')).tasks.find(t => t.url === `${base}/expired.bin` && t.status === 'error'))
  await win.locator('#task-inspector').getByText('下载地址已失效', { exact: true }).waitFor()
  await win.screenshot({ path: join(root, 'error.png') })
  assert.equal((await request('list')).tasks.length, 2)
  assert.deepEqual(pageErrors, [])
  report.passed = true
} catch (error) {
  report.error = String(error)
  if (win) { report.body = await win.locator('body').innerText().catch(() => ''); await win.screenshot({ path: join(root, 'failure.png') }).catch(() => {}) }
  process.exitCode = 1
} finally {
  await request('pauseAll').catch(() => {})
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
  if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM')
  await hostExit
  server.closeAllConnections(); await new Promise(r => server.close(r))
  await writeFile(join(root, 'host.log'), hostLog)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed ?? false, root, error: report.error, submitToServerRequestMs: report.submitToServerRequestMs, submitToFirstServerBodyMs: report.submitToFirstServerBodyMs, submitToVisibleProgressMs: report.submitToVisibleProgressMs, submitToVisibleSpeedMs: report.submitToVisibleSpeedMs }))
}
