// Actual Host RPC + temporary yt-dlp error fixture. No real site/cookie extraction.
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-media-access-host-'))
const tools = join(root, 'tools'), support = join(root, 'engine'), home = join(root, 'home')
for (const directory of [tools, support, home]) mkdirSync(directory)
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const hash = data => createHash('sha256').update(data).digest('hex')
const hostSHA256 = hash(readFileSync(hostBinary))
const cases = [
  { name: 'geo', diagnostic: 'This video is not available in your country', expected: 'regionRestricted' },
  { name: 'members', diagnostic: 'This video is for premium members only. Please log in to access.', expected: 'entitlementRequired' },
  { name: 'login', diagnostic: 'Sign in to confirm your age', expected: 'browserSessionRequired' },
  { name: 'cookies', diagnostic: 'Could not copy Chrome cookie database: permission denied', expected: 'browserDataUnavailable' }
]
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
writeFileSync(join(tools, 'yt-dlp'), `#!/bin/sh
name=unknown
for arg in "$@"; do
case "$arg" in
--version) printf '%s\\n' '2026.07.04-qa-fixture'; exit 0;;
${cases.map(item => `https://ndm-media-qa.invalid/${item.name}) name=${item.name};;`).join('\n')}
esac
done
printf '%s\\n' "$name" >> ${quote(join(root, 'fixture-calls.txt'))}
case "$name" in
${cases.map(item => `${item.name}) printf '%s\\n' ${quote('ERROR: ' + item.diagnostic)} >&2;;`).join('\n')}
*) printf '%s\\n' 'ERROR: unexpected fixture invocation' >&2;;
esac
exit 1
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
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: root,
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
    // No cookieBrowser: even cookie-read diagnostics come from text fixtures.
    const reply = await rpc('probeMedia', { url: `https://ndm-media-qa.invalid/${item.name}` })
    results.push({ name: item.name, expected: item.expected, actual: reply.errorKind, ok: reply.ok })
  }
  assert.deepEqual(readFileSync(join(root, 'fixture-calls.txt'), 'utf8').trim().split('\n'), cases.map(item => item.name), 'Every probe must execute the temporary fixture exactly once')
  assert.deepEqual((await rpc('list')).tasks, [], 'Failed probes must not create download tasks')
  const failures = results.filter(item => item.ok !== false || item.expected !== item.actual)
  assert.equal(hash(readFileSync(hostBinary)), hostSHA256, 'Selected Host changed during QA')
  const report = { passed: failures.length === 0, root, hostBinary, hostSHA256, scope: 'real isolated Host RPC; synthetic tool errors; no website or browser-cookie verification', results, noTasksCreated: true }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  assert.deepEqual(failures, [], 'Access errors must retain their distinct recovery categories')
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ root, hostBinary, error: String(error), results, stderr }, null, 2) + '\n')
  throw error
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await exited; clearTimeout(timer)
  }
}
