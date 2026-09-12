// Real isolated Host, bundled yt-dlp and ffmpeg, and an HttpOnly-cookie-gated
// local video page. This proves the Relay wire session survives probe + add.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-relay-media-session-'))
const support = join(root, 'engine'), home = join(root, 'home'), downloads = join(root, 'downloads')
for (const path of [support, home, downloads]) mkdirSync(path)
const tools = resolve('native/Vendor/Tools')
const hostBinary = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const hash = value => createHash('sha256').update(value).digest('hex')
const hostSHA256 = hash(readFileSync(hostBinary))
const fixture = join(root, 'fixture.mp4')
const generated = spawnSync(join(tools, 'ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=128x72:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-c:a', 'aac', '-movflags', '+faststart', fixture], { encoding: 'utf8' })
assert.equal(generated.status, 0, generated.stderr)
const payload = readFileSync(fixture)
const requests = { deniedPage: 0, authorizedPage: 0, authorizedVideo: 0, deniedVideo: 0, foreignCookies: 0 }
const sessionID = randomUUID()
let fixtureCookie = 'ndm_session=local-test-only'
const sessionJars = new Map()
const server = httpServer((request, response) => {
  const page = request.url.startsWith('/watch')
  const authenticated = request.headers.cookie?.split(';').map(item => item.trim()).includes(fixtureCookie)
  if (request.headers.cookie?.includes('unrelated_fixture')) requests.foreignCookies++
  requests[authenticated ? page ? 'authorizedPage' : 'authorizedVideo' : page ? 'deniedPage' : 'deniedVideo']++
  if (!authenticated) { response.writeHead(403); response.end('Session required'); return }
  if (page) {
    const html = '<!doctype html><html><head><title>Relay session fixture</title></head><body><video controls><source src="/fixture.mp4" type="video/mp4"></video></body></html>'
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) })
    response.end(request.method === 'HEAD' ? undefined : html)
  } else {
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
    const start = range ? Number(range[1]) : 0
    const end = Math.min(range?.[2] ? Number(range[2]) : payload.length - 1, payload.length - 1)
    const body = payload.subarray(start, end + 1)
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/watch`
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port; await new Promise(done => server.close(done)); return port
}
const hostPort = await freePort(), bridgePort = await freePort()
let sequence = 0, host, exited, socket, stderr = '', refreshRequests = 0
function rpc(op, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port: hostPort })
    let buffer = ''
    socket.setEncoding('utf8'); socket.setTimeout(100000, () => socket.destroy(new Error('RPC timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...fields }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let item
        try { item = JSON.parse(line) } catch { continue }
        if (item.id === id) { socket.end(); resolve(item); return }
      }
    })
  })
}
async function startHost() {
  host = spawn(hostBinary, [], { cwd: root, env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', NDM_SUPPORT_DIR: support, NDM_TOOL_DIR: tools,
    NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  exited = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', error => resolve({ error: error.message })) })
  host.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if ((await rpc('ping').catch(() => null))?.ok) { ready = true; break }
    await delay(100)
  }
  assert.ok(ready, 'Isolated Host must start')
}
async function stopHost() {
  socket?.close()
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await exited; clearTimeout(timer)
  }
}
async function connectBridge() {
  socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ndm/download`, 'ndm.open.v1')
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const prefix = 'NDMRelaySessionRequest:'
    if (!String(event.data).startsWith(prefix)) return
    const request = JSON.parse(String(event.data).slice(prefix.length))
    const jar = sessionJars.get(request.sessionID)
    if (jar === undefined || request.url !== url) return
    refreshRequests++
    socket.send('NDMRelaySessionResponse:' + JSON.stringify({ requestId: request.requestId,
      sessionID: request.sessionID, cookies: Buffer.from(jar).toString('base64') }))
  })
}
try {
  await startHost()
  assert.deepEqual((await rpc('list')).tasks, [])
  assert.equal((await rpc('probeMedia', { url })).ok, false, 'Anonymous page must be denied')
  assert.ok(requests.deniedPage > 0)
  const jar = '# Netscape HTTP Cookie File\n#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tndm_session\tlocal-test-only\n.unrelated.example\tTRUE\t/\tFALSE\t0\tunrelated_fixture\tnever-forward\n'
  sessionJars.set(sessionID, jar)
  await connectBridge()
  socket.send(`1:GET\r\n2:${url}\r\n6:media-page\r\n13:chrome\r\n14:${Buffer.from(jar).toString('base64')}\r\n15:${sessionID}\r\n`)
  await delay(150)
  const probe = await rpc('probeMedia', { url, browserSessionID: sessionID, browserSessionBrowser: 'chrome' })
  assert.equal(probe.ok, true, 'Relay session must make the same page accessible: ' + (probe.error ?? ''))
  assert.ok(probe.formats.length)
  // Signing in again in the same profile must replace the unexpired snapshot.
  fixtureCookie = 'ndm_session=local-test-probe-refreshed'
  sessionJars.set(sessionID, jar.replace('local-test-only', 'local-test-probe-refreshed'))
  const beforeProbeRefresh = refreshRequests
  const refreshedProbe = await rpc('probeMedia', { url, browserSessionID: sessionID, browserSessionBrowser: 'chrome' })
  assert.equal(refreshedProbe.ok, true, 'Probe must read the newly authorized session without waiting for the 30-minute cache expiry')
  assert.equal(refreshRequests, beforeProbeRefresh + 1)
  const anonymousID = randomUUID()
  sessionJars.set(anonymousID, '# Netscape HTTP Cookie File\n')
  socket.send(`1:GET\r\n2:${url}\r\n6:media-page\r\n13:chrome\r\n14:${Buffer.from('# Netscape HTTP Cookie File\n').toString('base64')}\r\n15:${anonymousID}\r\n`)
  await delay(100)
  assert.equal((await rpc('probeMedia', { url, browserSessionID: anonymousID, browserSessionBrowser: 'chrome' })).ok, false, 'Same URL in an anonymous profile must never inherit another profile session')
  assert.equal((await rpc('probeMedia', { url })).ok, false, 'Manual anonymous probe must not implicitly use the most recent Relay profile')
  const added = await rpc('addMedia', { url, browserSessionID: sessionID, browserSessionBrowser: 'chrome', formatID: probe.formats[0].id, folderPath: downloads, filename: 'Relay-session-proof.mp4', autoStart: true })
  assert.equal(added.ok, true, added.error)
  const taskID = added.task?.id ?? added.tasks?.[0]?.id
  assert.ok(taskID)
  let task
  for (let i = 0; i < 200; i++) {
    task = (await rpc('list')).tasks.find(item => item.id === taskID)
    if (['complete', 'error'].includes(task?.status)) break
    await delay(100)
  }
  assert.equal(task?.status, 'complete', task?.errorText)
  const file = join(task.folderPath, task.filename)
  const downloaded = readFileSync(file)
  assert.equal(hash(downloaded), hash(payload), 'Authenticated media bytes must match the original fixture')
  const decoded = spawnSync(join(tools, 'ffmpeg'), ['-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8' })
  assert.equal(decoded.status, 0, decoded.stderr)
  assert.ok(requests.authorizedPage >= 2, 'Probe and creation both use browser session')
  assert.ok(requests.authorizedVideo > 0, 'Download uses browser session')
  assert.equal(requests.foreignCookies, 0)
  assert.equal(readdirSync(root).filter(name => name.startsWith('ndm-media-session-')).length, 0, 'All invocation cookie jars must be deleted')
  assert.equal(readFileSync(join(support, 'NeatDB.db')).includes(Buffer.from('local-test-')), false, 'Raw cookie must not be stored with task')
  for (const file of readdirSync(join(support, 'Preflight'))) {
    assert.equal(readFileSync(join(support, 'Preflight', file)).includes(Buffer.from('local-test-')), false, 'yt-dlp cookie fields must not be retained in extraction cache')
  }
  // A queued/retried download can outlive the authorization used for its probe.
  fixtureCookie = 'ndm_session=local-test-download-refreshed'
  sessionJars.set(sessionID, jar.replace('local-test-only', 'local-test-download-refreshed'))
  const beforeDownloadRefresh = refreshRequests, beforeRotatedVideo = requests.authorizedVideo
  assert.equal((await rpc('retry', { taskID })).ok, true)
  for (let i = 0; i < 200; i++) {
    task = (await rpc('list')).tasks.find(item => item.id === taskID)
    if (task?.status === 'error' || (task?.status === 'complete' && requests.authorizedVideo > beforeRotatedVideo)) break
    await delay(100)
  }
  assert.equal(task?.status, 'complete', task?.errorText)
  assert.ok(requests.authorizedVideo > beforeRotatedVideo)
  assert.equal(refreshRequests, beforeDownloadRefresh + 1, 'An authorization rejection refreshes the original profile exactly once')
  assert.equal(hash(readFileSync(join(task.folderPath, task.filename))), hash(payload))
  await stopHost()
  await startHost()
  await connectBridge()
  const previousVideoRequests = requests.authorizedVideo
  assert.equal((await rpc('retry', { taskID })).ok, true)
  for (let i = 0; i < 200; i++) {
    task = (await rpc('list')).tasks.find(item => item.id === taskID)
    if (task?.status === 'error' || (task?.status === 'complete' && requests.authorizedVideo > previousVideoRequests)) break
    await delay(100)
  }
  assert.equal(task?.status, 'complete', task?.errorText)
  assert.ok(refreshRequests > 0, 'Retry after Host restart must refresh from the exact original Relay profile')
  assert.ok(requests.authorizedVideo > previousVideoRequests)
  assert.equal(hash(readFileSync(join(task.folderPath, task.filename))), hash(payload))
  const unavailable = await rpc('probeMedia', { url, browserSessionID: randomUUID(), browserSessionBrowser: 'chrome' })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.errorKind, 'browserDataUnavailable', 'An unavailable original profile must not become a default-profile or anonymous probe')
  assert.equal(readdirSync(root).filter(name => name.startsWith('ndm-media-session-')).length, 0)
  const report = { passed: true, root, hostBinary, hostSHA256, scope: 'real isolated Host + bundled yt-dlp + ffmpeg; synthetic local HttpOnly session, no real user cookies', requests, downloadedBytes: downloaded.length, sha256: hash(downloaded), playable: true, cookieFilesRemoved: true, cookiesAbsentFromTaskDatabase: true, cookiesAbsentFromPreflight: true, anonymousProfileIsolated: true, refreshRequests, restartRetryDownloaded: true, missingProfileExplicit: true, freshProbeReadsUpdatedProfile: true, cachedAuthRetryRefreshedOnce: true }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ root, error: String(error), requests, stderr }, null, 2) + '\n')
  throw error
} finally {
  await stopHost()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
