// Opt-in real public BBB download, isolated Host; retain only sanitized report.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const targetHeight = Number(process.env.NDM_QA_HEIGHT || 1080)
assert.ok([360, 1080].includes(targetHeight), 'Unsupported QA tier')
const MiB = 1024 ** 2, budget = 512 * MiB, stopAt = 448 * MiB
const disk = statfsSync(tmpdir()), availableBytes = disk.bavail * disk.bsize
assert.ok(availableBytes > 1024 * MiB, 'At least 1 GiB free space required')
const root = mkdtempSync(join(tmpdir(), 'ndm-public-media-download-'))
const owned = join(root, 'owned'), home = join(owned, 'home'), support = join(owned, 'support'), downloads = join(owned, 'downloads')
for (const path of [home, support, downloads, join(home, '.config')]) mkdirSync(path, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || '/Applications/NDM.app/Contents/Resources/bin/NDMHost')
const tools = resolve(process.env.NDM_QA_TOOL_DIR || '/Applications/NDM.app/Contents/Resources/Tools')
const ffprobe = resolve(process.env.NDM_QA_FFPROBE_PATH || '/opt/homebrew/bin/ffprobe')
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: owned,
  LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: tools, NDM_DISABLE_LEGACY_BRIDGE: '1' }
const hash = data => createHash('sha256').update(data).digest('hex')
const report = { passed: false, source: 'https://www.youtube.com/watch?v=YE7VzlLtp-4', root,
  availableBytes, budgetBytes: budget, stopThresholdBytes: stopAt, deadlineSeconds: 180,
  scope: 'Anonymous real Host probeMedia/addMedia; public Blender BBB; no browser cookies or user configuration',
  budgetMethod: 'Estimate gate plus 200ms monitoring with 64MiB headroom, not a filesystem quota', peakLogicalBytes: 0, peakAllocatedBytes: 0, statuses: [] }
let host, hostDone, taskID, timer, monitor, stopping = false, stopPromise, sequence = 0, port, started
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const value = server.address().port; await new Promise(done => server.close(done)); return value
}
function rpc(op, fields = {}, timeout = 5000) {
  return new Promise((done, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port }); let buffer = '', settled = false
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : done(value) }
    socket.setEncoding('utf8'); socket.setTimeout(timeout, () => finish(Error('rpc-timeout')))
    socket.on('error', () => finish(Error('rpc-error'))); socket.on('close', () => finish(Error('rpc-closed')))
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      try { const reply = JSON.parse(line); if (reply.id === id) finish(null, reply) } catch { finish(Error('rpc-json')) }
    } })
  })
}
function measure() {
  let logical = 0, allocated = 0
  function walk(path) { for (const name of readdirSync(path)) {
    const child = join(path, name); let stat
    try { stat = lstatSync(child) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) walk(child)
    else if (stat.isFile()) { logical += stat.size; allocated += stat.blocks * 512 }
  } }
  walk(owned); report.peakLogicalBytes = Math.max(report.peakLogicalBytes, logical)
  report.peakAllocatedBytes = Math.max(report.peakAllocatedBytes, allocated)
  return Math.max(logical, allocated)
}
function signalGroup(signal) {
  if (!host || !Number.isInteger(host.pid) || host.pid <= 1) return
  try { process.kill(-host.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function errorCategory(value) {
  const text = String(value || '').toLowerCase()
  if (/certificate|ssl|tls/.test(text)) return 'tls'
  if (/403|forbidden/.test(text)) return 'http-forbidden'
  if (/429|too many/.test(text)) return 'rate-limited'
  if (/format|格式/.test(text)) return 'format-or-conversion'
  if (/cookie|login|sign in|登录/.test(text)) return 'session-or-access'
  if (/timeout|timed out|超时/.test(text)) return 'timeout'
  if (/network|connection|网络/.test(text)) return 'network'
  return 'unclassified'
}
async function stop(reason) {
  if (stopPromise) return stopPromise
  stopping = true
  stopPromise = (async () => {
    if (reason) report.stopReason = reason
    if (taskID) await rpc('pause', { taskID }, 1000).catch(() => null)
    signalGroup('SIGTERM')
    await Promise.race([hostDone || Promise.resolve(), delay(1000)])
    signalGroup('SIGKILL') // Include any remaining own yt-dlp/ffmpeg descendants.
    if (hostDone) await hostDone
    // SIGKILL delivery is asynchronous; wait until the owned process group is gone.
    if (host?.pid) for (let attempt = 0; ; attempt++) {
      try { process.kill(-host.pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
      assert.ok(attempt < 100, 'owned-process-group-did-not-exit')
      await delay(50)
    }
  })()
  return stopPromise
}
try {
  report.hostSHA256 = hash(readFileSync(hostPath)); report.toolSHA256 = hash(readFileSync(join(tools, 'yt-dlp')))
  report.ffprobeSHA256 = hash(readFileSync(ffprobe))
  const version = spawnSync(join(tools, 'yt-dlp'), ['--ignore-config', '--version'], { env, encoding: 'utf8', timeout: 15000 })
  report.toolVersion = /^\d{4}\.\d{2}\.\d{2}$/.test(version.stdout?.trim()) ? version.stdout.trim() : 'unavailable'
  port = await freePort(); let bridge = await freePort(); while (bridge === port) bridge = await freePort()
  started = Date.now(); report.startedAt = new Date(started).toISOString()
  timer = setTimeout(() => void stop('deadline'), 180000)
  host = spawn(hostPath, [], { cwd: owned, env: { ...env, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge) }, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  hostDone = new Promise(done => { host.once('exit', done); host.once('error', done) })
  monitor = setInterval(() => { try { if (measure() >= stopAt) void stop('output-budget') } catch { void stop('measurement-failed') } }, 200)
  let ready = false
  for (let i = 0; i < 100 && !stopping; i++) { if ((await rpc('ping', {}, 500).catch(() => null))?.ok) { ready = true; break } await delay(100) }
  assert.ok(ready, 'host-unavailable'); assert.deepEqual((await rpc('list')).tasks, [], 'store-not-empty')
  console.log(JSON.stringify({ event: 'probe-starting', root }))
  const probe = await rpc('probeMedia', { url: report.source }, 100000)
  assert.ok(probe.ok, 'probe-failed'); assert.ok(!stopping, 'stopped')
  const format = probe.formats?.find(f => f.isVideo === true && f.height === targetHeight)
  assert.ok(format, 'missing-1080-tier')
  const estimatedBytes = Number(format.approximateBytes)
  report.estimatedBytes = estimatedBytes; report.selectedHeight = targetHeight; report.sourceDurationSeconds = probe.duration
  assert.ok(estimatedBytes > 0 && estimatedBytes * 2 + 32 * MiB < stopAt, 'estimate-exceeds-budget-or-unknown')
  const added = await rpc('addMedia', { url: report.source, formatID: format.id, container: 'compatibleMP4', collectionScope: 'current', folderPath: downloads, filename: 'bbb-public-1080.mp4' }, 15000)
  assert.ok(added.ok && added.task?.id, 'add-media-failed'); taskID = added.task.id
  console.log(JSON.stringify({ event: 'download-starting', height: targetHeight, estimatedBytes }))
  let finalTask
  while (!stopping) {
    const task = (await rpc('list')).tasks?.find(t => t.id === taskID)
    const status = task?.status
    if (typeof status === 'string' && ['pending', 'waiting', 'downloading', 'paused', 'complete', 'error', 'merging', 'preparing'].includes(status) && report.statuses.at(-1) !== status) report.statuses.push(status)
    if (status === 'error') {
      const text = String(task.errorText || '')
      report.downloadErrorCategory = errorCategory(text)
      report.httpStatus = Number(text.match(/(?:HTTP(?: Error)?|status(?: code)?)[: ]+(\d{3})/i)?.[1]) || null
      report.failureStage = /requested format.*not available|no video formats/i.test(text) ? 'format-selection' : /ffmpeg|merg|conversion/i.test(text) ? 'postprocessing' : /fragment/i.test(text) ? 'fragment-transfer' : /download|下载|403/i.test(text) ? 'media-transfer' : 'unknown'
    }
    assert.notEqual(status, 'error', 'download-failed')
    if (status === 'complete') { finalTask = task; break }
    await delay(250)
  }
  assert.ok(finalTask && !stopping, 'download-not-complete')
  const finalPath = resolve(finalTask.folderPath, finalTask.filename)
  assert.equal(dirname(finalPath), downloads, 'output-outside-owned-directory')
  assert.ok(lstatSync(finalPath).isFile() && !lstatSync(finalPath).isSymbolicLink(), 'output-not-regular-file')
  measure(); assert.ok(report.peakLogicalBytes <= budget && report.peakAllocatedBytes <= budget, 'budget-exceeded')
  const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', finalPath], { env, encoding: 'utf8', timeout: Math.min(15000, Math.max(1, 180000 - (Date.now() - started))) })
  assert.equal(inspected.status, 0, 'ffprobe-failed')
  const metadata = JSON.parse(inspected.stdout)
  report.streams = metadata.streams.map(s => ({ type: s.codec_type, codec: s.codec_name, ...(s.codec_type === 'video' ? { width: s.width, height: s.height } : {}) }))
  report.durationSeconds = Number(metadata.format.duration)
  assert.ok(report.streams.some(s => s.type === 'video' && s.height === targetHeight), 'missing-1080-video')
  assert.ok(report.streams.some(s => s.type === 'audio'), 'missing-audio')
  assert.ok(Math.abs(report.durationSeconds - 597) < 3, 'duration-mismatch')
  report.finalBytes = lstatSync(finalPath).size; report.finalSHA256 = hash(readFileSync(finalPath))
  assert.ok(Date.now() - started < 180000, 'deadline')
  report.passed = true
} catch (error) {
  const allowed = ['host-unavailable', 'probe-failed', 'stopped', 'missing-1080-tier', 'estimate-exceeds-budget-or-unknown', 'add-media-failed', 'download-failed', 'download-not-complete', 'budget-exceeded', 'ffprobe-failed', 'missing-1080-video', 'missing-audio', 'duration-mismatch', 'deadline']
  report.failureCategory = allowed.find(value => error.message?.includes(value)) || 'qa-failed'
} finally {
  clearTimeout(timer); clearInterval(monitor); await stop()
  // Parent and owned directory must still be the exact non-symlink directories created here.
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink())
  assert.ok(lstatSync(owned).isDirectory() && !lstatSync(owned).isSymbolicLink())
  rmSync(owned, { recursive: true, force: false })
  report.transientDataRemoved = true; report.elapsedSeconds = started ? (Date.now() - started) / 1000 : 0
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1
}
