// Actual Host RPC + successful yt-dlp preview fixtures. No websites or cookies.
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-media-preview-host-'))
const tools = join(root, 'tools'), support = join(root, 'engine'), home = join(root, 'home')
for (const directory of [tools, support, home]) mkdirSync(directory)
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const hash = data => createHash('sha256').update(data).digest('hex')
const hostSHA256 = hash(readFileSync(hostBinary))
const marker = 'Only preview format is available,'
// Fixed 2026.07.04 bilibili.py report_warning omits video_id; common.py
// prepends IE_NAME only. Do not invent an episode-id prefix here.
const warning = `WARNING: [BiliBiliBangumi] ${marker} you have to become a premium member to access full video.`
const cases = [
  { name: 'preview', warning, expected: 'previewOnly' },
  { name: 'short', duration: 3 },
  { name: 'member-quality', warning: 'Format(s) 1080P are missing; you have to become a premium member to download them.' },
  { name: 'subtitle-login', warning: 'WARNING: [BiliBiliBangumi] 42: Subtitles are only available when logged in.' },
  { name: 'title-marker', title: warning },
  { name: 'unrelated', extractor: 'Generic', warning },
  { name: 'split-stderr', warning, split: true, expected: 'previewOnly' },
  { name: 'no-newline', warning, noNewline: true, expected: 'previewOnly' }
]
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const fixtureCase = item => {
  const json = JSON.stringify({ id: '42', extractor_key: item.extractor || 'BiliBiliBangumi',
    title: item.title || 'Preview fixture', duration: item.duration || 90,
    formats: [{ format_id: '18', url: 'https://ndm-media-qa.invalid/payload.mp4', ext: 'mp4', height: 360,
      vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', filesize: 1024 }] })
  let stderr = ''
  if (item.warning) {
    stderr = item.split
      ? `printf '%s' ${quote(item.warning.slice(0, 37))} >&2; sleep 0.05; printf '%s\\n' ${quote(item.warning.slice(37))} >&2`
      : `printf '${item.noNewline ? '%s' : '%s\\n'}' ${quote(item.warning)} >&2`
    stderr = `if [ "$warnings" = yes ]; then ${stderr}; fi`
  }
  return `${item.name}) ${stderr ? stderr + '; ' : ''}printf '%s\\n' ${quote(json)};;`
}
writeFileSync(join(tools, 'yt-dlp'), `#!/bin/sh
name=unknown
warnings=yes
for arg in "$@"; do
case "$arg" in
--version) printf '%s\\n' '2026.07.04-qa-fixture'; exit 0;;
--no-warnings) warnings=no;;
${cases.map(item => `https://ndm-media-qa.invalid/${item.name}) name=${item.name};;`).join('\n')}
esac
done
printf '%s\\n' "$name" >> ${quote(join(root, 'fixture-calls.txt'))}
case "$name" in
${cases.map(fixtureCase).join('\n')}
*) printf '%s\\n' 'ERROR: unexpected fixture invocation' >&2; exit 1;;
esac
`, { mode: 0o700 })
// The .invalid URLs are not ShortLinkExpander hosts and not collection URLs.
// MediaPreflight therefore reaches the fixture without resolving a webpage.
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
    socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy(new Error('RPC timeout')))
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
    LANG: 'en_US.UTF-8', NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: tools,
    NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  exited = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', error => resolve({ error: error.message })) })
  host.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rpc('ping').catch(() => null))?.ok) { ready = true; break }
    if (host.exitCode !== null || host.signalCode !== null) throw Error('Host exited before ready: ' + stderr)
    await delay(100)
  }
  assert.ok(ready, 'Isolated Host must start')
  assert.deepEqual((await rpc('list')).tasks, [], 'Fresh isolated task store')
  for (const item of cases) {
    const reply = await rpc('probeMedia', { url: `https://ndm-media-qa.invalid/${item.name}` })
    assert.equal(reply.ok, true, 'All fixtures must remain successful probes')
    assert.ok(reply.formats?.length > 0, 'Preview does not discard formats')
    results.push({ name: item.name, expected: item.expected || null, actual: reply.availabilityNotice ?? null, ok: reply.ok })
    assert.equal(Object.hasOwn(reply, 'stderr'), false)
    assert.equal(Object.hasOwn(reply, 'warnings'), false)
    assert.equal(Object.hasOwn(reply, 'error'), false)
  }
  const cached = await rpc('probeMedia', { url: 'https://ndm-media-qa.invalid/preview' })
  assert.equal(cached.availabilityNotice ?? null, results[0].actual, 'In-memory preflight cache preserves the notice')
  assert.deepEqual(readFileSync(join(root, 'fixture-calls.txt'), 'utf8').trim().split('\n'), cases.map(item => item.name), 'Every probe must execute the temporary fixture exactly once')
  assert.deepEqual((await rpc('list')).tasks, [], 'Successful metadata probes must not create download tasks')
  assert.ok(readdirSync(join(home, 'Library/Caches/dev.ndm.open/Preflight')).some(name => name.endsWith('.info.json')), 'Success cache must be under isolated Foundation home')
  const failures = results.filter(item => item.ok !== true || item.expected !== item.actual)
  assert.equal(hash(readFileSync(hostBinary)), hostSHA256, 'Selected Host changed during QA')
  const report = { passed: failures.length === 0, root, hostBinary, hostSHA256, scope: 'real isolated Host RPC; synthetic successful tool results; no website or browser-cookie verification', results, noTasksCreated: true }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  assert.deepEqual(failures, [], 'Only explicit matching preview signals may set the notice')
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ root, hostBinary, error: String(error), results, stderr }, null, 2) + '\n')
  throw error
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await exited; clearTimeout(timer)
  }
}
