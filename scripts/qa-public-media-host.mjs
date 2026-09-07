// Selected Host anonymous public metadata probes. Only sanitized statistics are reported; isolated preflight cache is cleaned.
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-public-media-host-'))
const tools = resolve(process.env.NDM_QA_TOOL_DIR || '/Applications/NDM.app/Contents/Resources/Tools')
const support = join(root, 'engine'), home = join(root, 'home')
for (const directory of [support, home, join(home, '.config')]) mkdirSync(directory, { recursive: true })
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || '/Applications/NDM.app/Contents/Resources/bin/NDMHost')
const hash = data => createHash('sha256').update(data).digest('hex')
const hostSHA256 = hash(readFileSync(hostBinary))
const toolSHA256 = hash(readFileSync(join(tools, 'yt-dlp')))
const versionResult = spawnSync(join(tools, 'yt-dlp'), ['--ignore-config', '--version'], { encoding: 'utf8', timeout: 15000,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root } })
const toolVersion = /^\d{4}\.\d{2}\.\d{2}$/.test((versionResult.stdout || '').trim()) ? versionResult.stdout.trim() : 'unavailable'
const availableCases = [
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4' },
  { name: 'Vimeo', url: 'https://vimeo.com/76979871' },
  { name: 'Bilibili', url: 'https://www.bilibili.com/video/BV13x41117TL' }
]
const cases = process.env.NDM_QA_SITE ? availableCases.filter(item => item.name === process.env.NDM_QA_SITE) : availableCases
assert.ok(cases.length > 0, 'Unknown requested public sample')
function category(value) {
  const text = String(value || '').toLowerCase()
  if (/certificate|ssl|tls/.test(text)) return 'tls'
  if (/timed out|timeout|超时/.test(text)) return 'timeout'
  if (/oauth/.test(text)) return 'client-authentication'
  if (/\b412\b|precondition failed/.test(text)) return 'http-412'
  if (/\b401\b|unauthorized/.test(text)) return 'http-401'
  if (/cookie|login|log in|sign in|登录/.test(text)) return 'session-or-access'
  if (/403|429|forbidden|too many/.test(text)) return 'request-rejected'
  if (/unavailable|not available|不可用/.test(text)) return 'unavailable'
  return 'unclassified'
}
const allowedKinds = new Set(['browserSessionRequired', 'browserDataUnavailable', 'regionRestricted', 'entitlementRequired', 'probeFailed'])
function removeOwnedPreflightCache() {
  // Never resolve through a symlink or widen deletion to HOME/support/report.
  let path = root
  for (const component of ['', 'home', 'Library', 'Caches', 'dev.ndm.open', 'Preflight']) {
    if (component) path = join(path, component)
    let stat
    try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Refusing cache cleanup through a non-directory or symlink')
  }
  assert.equal(path, join(home, 'Library/Caches/dev.ndm.open/Preflight'))
  rmSync(path, { recursive: true, force: false })
}
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port; await new Promise(done => server.close(done)); return port
}
const hostPort = await freePort()
let bridgePort = await freePort()
while (bridgePort === hostPort) bridgePort = await freePort()
let sequence = 0, host, exited, stderr = ''
function rpc(op, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port: hostPort })
    let buffer = ''
    socket.setEncoding('utf8'); socket.setTimeout(110000, () => socket.destroy(new Error('RPC timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let item
        try { item = JSON.parse(line) } catch (error) { socket.destroy(error); return }
        if (item.id === id) { socket.end(); resolve(item); return }
      }
    })
  })
}
const results = []
try {
  // No inherited proxy, browser profile, tool override or live-library settings.
  host = spawn(hostBinary, [], { cwd: root, env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: tools,
    NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  exited = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', error => resolve({ error: error.message })) })
  host.stderr.on('data', () => {}) // Drain diagnostics without persisting raw URLs or credentials.
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rpc('ping').catch(() => null))?.ok) { ready = true; break }
    if (host.exitCode !== null || host.signalCode !== null) throw Error('Host exited before ready: ' + stderr)
    await delay(100)
  }
  assert.ok(ready, 'Isolated Host must start')
  assert.deepEqual((await rpc('list')).tasks, [], 'Fresh isolated task store')
  for (const item of cases) {
    console.log(JSON.stringify({ event: 'starting', site: item.name }))
    const started = Date.now()
    let result
    try {
      const reply = await rpc('probeMedia', { url: item.url })
      const formats = Array.isArray(reply.formats) ? reply.formats : []
      result = { site: item.name, ok: reply.ok === true,
        errorKind: allowedKinds.has(reply.errorKind) ? reply.errorKind : null,
        errorCategory: reply.ok === true ? null : category(reply.error),
        formatTierCount: formats.length, videoTierCount: formats.filter(f => f.isVideo === true).length,
        heights: [...new Set(formats.map(f => f.height).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b),
        durationSeconds: Number.isFinite(reply.duration) ? reply.duration : null }
    } catch (error) { result = { site: item.name, ok: false, errorKind: null, errorCategory: category(error) } }
    result.elapsedSeconds = (Date.now() - started) / 1000
    results.push(result)
    console.log(JSON.stringify({ event: 'result', ...result }))
  }
  assert.deepEqual((await rpc('list')).tasks, [], 'Metadata probes must not create download tasks')
  assert.equal(hash(readFileSync(hostBinary)), hostSHA256, 'Selected Host changed during QA')
  const report = { completedAt: new Date().toISOString(), root, hostSHA256, toolSHA256, toolVersion,
    scope: 'selected Host anonymous metadata/format tiers only; no media or cookies', results, noTasksCreated: true }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ event: 'complete', ...report }))

} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ root, errorCategory: category(error), results }, null, 2) + '\n')
  throw new Error('Public media probe failed; see sanitized failure report')
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await exited; clearTimeout(timer)
  }
  removeOwnedPreflightCache()
}
