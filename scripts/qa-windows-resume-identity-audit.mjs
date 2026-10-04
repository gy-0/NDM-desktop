// Observational audit of Windows engine orchestration on the current host OS.
// Only synthetic HTTP data and an isolated aria2 process are used.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const root = await mkdtemp(join(tmpdir(), 'ndm-resume-identity-audit-'))
const sha = data => createHash('sha256').update(data).digest('hex')
const noncompliant = process.argv.includes('--noncompliant')
const size = 8 * 1024 * 1024
const bodies = [Buffer.alloc(size, 0x41), Buffer.alloc(size, 0x42)]
let version = 0, engine, changeAfterProbe = false
const requests = []
const server = createServer((req, res) => {
  const v = version, body = bodies[v]
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  requests.push({ version: v, method: req.method, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null, ifMatch: req.headers['if-match'] ?? null })
  if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
  // Honour If-Range if the downloader supplies one.
  const partial = range && (noncompliant || !req.headers['if-range'] || req.headers['if-range'] === `"version-${v}"`)
  const begin = partial ? start : 0, last = partial ? end : size - 1
  res.writeHead(partial ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': last - begin + 1,
    'Accept-Ranges': 'bytes', ETag: `"version-${v}"`, ...(partial ? { 'Content-Range': `bytes ${begin}-${last}/${size}` } : {}) })
  if (changeAfterProbe && req.headers.range === 'bytes=0-0') { version = 1; changeAfterProbe = false }
  if (req.method === 'HEAD') { res.end(); return }
  let offset = begin
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return }
    const next = Math.min(offset + 65536, last + 1)
    res.write(body.subarray(offset, next)); offset = next
    if (offset > last) { clearInterval(timer); res.end() }
  }, 12)
  res.on('close', () => clearInterval(timer))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function freePort() { const s = tcpServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port }
await build({ entryPoints: ['src/main/windows/windowsEngine.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'engine.mjs') })
const { WindowsDownloadEngine } = await import(pathToFileURL(join(root, 'engine.mjs')))
await build({ entryPoints: ['src/main/windows/httpRepresentation.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'identity.mjs') })
const { probeHTTPRepresentation } = await import(pathToFileURL(join(root, 'identity.mjs')))
const report = { noncompliant, platform: process.platform, scope: 'Windows orchestration with local aria2 on '+process.platform+'; not installer or desktop UI acceptance', root, requests, cases: [] }
async function boot(state) {
  let status
  const instance = new WindowsDownloadEngine({ stateDirectory: join(root, state), defaultDownloadDirectory: join(root, 'downloads'),
    aria2Path: process.env.NDM_AUDIT_ARIA2 || '/opt/homebrew/bin/aria2c', ytDlpPath: '/unused', ffmpegPath: '/unused', rpcPort: await freePort() },
    { onStatus: value => { status = value }, onEvent: () => {},
      openHTTPResponse: process.argv.includes('--expect-post-rejected') ? undefined : (url, headers, signal, proxy, request) => {
        assert.equal(proxy, undefined)
        return fetch(url, { headers, signal, redirect: 'manual', method: request?.method ?? 'GET', ...(request ? { body: request.body } : {}) })
      },
      inspectHTTPRepresentation: (url, headers) => probeHTTPRepresentation(url, headers, async request => {
        const response = await fetch(request.url, { headers: request.headers, redirect: 'manual', signal: request.signal })
        const reply = { status: response.status, url: response.url, headers: Object.fromEntries(response.headers) }
        await response.body?.cancel()
        return reply
      }, AbortSignal.timeout(8000)) })
  await instance.start(); assert.equal(status, 'live'); return instance
}
async function task(id, predicate, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = (await engine.request('list')).tasks.find(t => t.id === id)
    if (result && predicate(result)) return result
    await delay(50)
  }
  throw new Error(`Task ${id} did not reach expected state`)
}
try {
  for (const changed of (process.argv.includes('--post-only') ? [] : noncompliant ? ['after-probe'] : process.argv.includes('--expect-identity') ? [false, true, 'after-probe'] : [false, true])) {
    version = 0
    const state = `state-${String(changed)}`
    engine = await boot(state)
    const filename = `fixture-${String(changed)}.bin`
    const added = await engine.request('add', { url: `http://127.0.0.1:${server.address().port}/${filename}`, filename, folderPath: join(root, 'downloads'), connections: 1 })
    assert.equal(added.ok, true)
    const id = added.task.id
    await task(id, t => t.completedBytes >= 1024 * 1024 && t.status === 'downloading')
    await engine.request('pause', { taskID: id })
    const paused = await task(id, t => t.status === 'paused')
    const pausedTask = engine.tasks.find(t => t.id === id)
    const actualPause = await engine.rpc.call('tellStatus', [pausedTask.gid, ['status', 'completedLength']])
    assert.equal(actualPause.status, 'paused', 'UI pause must not precede actual aria2 settlement')
    assert.equal(paused.completedBytes, Number(actualPause.completedLength))
    if (!process.argv.includes('--same-session')) { await engine.stop(); engine = null; await delay(900) }
    const savedSHA = sha(await readFile(join(root, 'downloads', filename)))
    version = changed === true ? 1 : 0
    changeAfterProbe = changed === 'after-probe'
    if (!engine) engine = await boot(state)
    let rejection
    await engine.request('resume', { taskID: id }).catch(error => { rejection = error.message })
    const terminal = rejection ? await task(id, () => true) : await task(id, t => ['complete', 'error'].includes(t.status))
    let result
    if (terminal.status === 'complete') {
      const bytes = await readFile(join(terminal.folderPath, terminal.filename))
      result = { bytes: bytes.length, sha256: sha(bytes), matchesOld: bytes.equals(bodies[0]), matchesCurrent: bytes.equals(bodies[version]),
        oldByteCount: bytes.filter(byte => byte === 0x41).length, newByteCount: bytes.filter(byte => byte === 0x42).length }
      if (!changed) assert.equal(result.matchesCurrent, true, 'Control resume must be correct')
    }
    if (process.argv.includes('--expect-identity')) {
      if (changed) {
        assert.notEqual(terminal.status, 'complete')
        if (changed === true) assert.ok(rejection)
        else assert.equal(terminal.status, 'error')
        assert.equal(sha(await readFile(join(root, 'downloads', filename))), savedSHA, 'Rejected resume must preserve saved bytes')
      }
      else { assert.equal(rejection, undefined); assert.equal(result.matchesCurrent, true) }
    }
    let writerStatus
    if (!rejection && terminal.status === 'error') {
      const gid = engine.tasks.find(t => t.id === id).gid
      writerStatus = (await engine.rpc.call('tellStatus', [gid, ['status']])).status
      assert.ok(['error', 'removed', 'paused'].includes(writerStatus), 'UI failure must wait for the writer to stop')
    }
    report.cases.push({ changed, rejection, savedPrefix: paused.completedBytes, status: terminal.status, writerStatus, result })
    await engine.stop(); engine = null; await delay(900)
  }
  if (process.argv.includes('--post-only')) {
    engine = await boot('post-state')
    let rejection
    const added = await engine.request('add', { url: `http://127.0.0.1:${server.address().port}/post.bin`,
      filename: 'post.bin', folderPath: join(root, 'downloads'), method: 'POST', body: 'fixture=form', connections: 1 }).catch(error => { rejection = error.message; return { ok: false } })
    if (process.argv.includes('--expect-post-rejected')) {
      assert.equal(added.ok, false)
      assert.match(rejection ?? '', /传输不可用/)
      assert.equal(requests.length, 0)
      assert.deepEqual((await engine.request('list')).tasks, [])
    }
    const terminal = added.ok ? await task(added.task.id, t => ['complete', 'error'].includes(t.status)) : null
    if (!process.argv.includes('--expect-post-rejected')) {
      assert.equal(terminal?.status, 'complete'); assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST')
      assert.deepEqual(await readFile(join(terminal.folderPath, terminal.filename)), bodies[version])
    }
    report.cases.push({ scenario: 'explicit POST request', accepted: added.ok, rejection, status: terminal?.status,
      actualMethods: requests.map(r => r.method) })
  }
  report.completed = true
} catch (error) { report.error = String(error); throw error }
finally {
  if (engine) await engine.stop()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
