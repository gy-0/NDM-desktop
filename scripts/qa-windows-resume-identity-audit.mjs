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
const size = 8 * 1024 * 1024
const bodies = [Buffer.alloc(size, 0x41), Buffer.alloc(size, 0x42)]
let version = 0, engine
const requests = []
const server = createServer((req, res) => {
  const v = version, body = bodies[v]
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  requests.push({ version: v, method: req.method, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null, ifMatch: req.headers['if-match'] ?? null })
  if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
  // Honour If-Range if the downloader supplies one.
  const partial = range && (!req.headers['if-range'] || req.headers['if-range'] === `"version-${v}"`)
  const begin = partial ? start : 0, last = partial ? end : size - 1
  res.writeHead(partial ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': last - begin + 1,
    'Accept-Ranges': 'bytes', ETag: `"version-${v}"`, ...(partial ? { 'Content-Range': `bytes ${begin}-${last}/${size}` } : {}) })
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
const report = { scope: 'Windows orchestration with macOS aria2, not native Windows validation', root, requests, cases: [] }
async function boot(state) {
  let status
  const instance = new WindowsDownloadEngine({ stateDirectory: join(root, state), defaultDownloadDirectory: join(root, 'downloads'),
    aria2Path: process.env.NDM_AUDIT_ARIA2 || '/opt/homebrew/bin/aria2c', ytDlpPath: '/unused', ffmpegPath: '/unused', rpcPort: await freePort() },
    { onStatus: value => { status = value }, onEvent: () => {} })
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
  for (const changed of (process.argv.includes('--post-only') ? [] : [false, true])) {
    version = 0
    const state = changed ? 'changed-state' : 'control-state'
    engine = await boot(state)
    const filename = changed ? 'changed.bin' : 'control.bin'
    const added = await engine.request('add', { url: `http://127.0.0.1:${server.address().port}/${filename}`, filename, folderPath: join(root, 'downloads'), connections: 1 })
    assert.equal(added.ok, true)
    const id = added.task.id
    await task(id, t => t.completedBytes >= 1024 * 1024 && t.status === 'downloading')
    await engine.request('pause', { taskID: id })
    const paused = await task(id, t => t.status === 'paused')
    await engine.stop(); engine = null; await delay(900)
    version = changed ? 1 : 0
    engine = await boot(state)
    await engine.request('resume', { taskID: id })
    const terminal = await task(id, t => ['complete', 'error'].includes(t.status))
    let result
    if (terminal.status === 'complete') {
      const bytes = await readFile(join(terminal.folderPath, terminal.filename))
      result = { bytes: bytes.length, sha256: sha(bytes), matchesOld: bytes.equals(bodies[0]), matchesCurrent: bytes.equals(bodies[version]),
        oldByteCount: bytes.filter(byte => byte === 0x41).length, newByteCount: bytes.filter(byte => byte === 0x42).length }
      if (!changed) assert.equal(result.matchesCurrent, true, 'Control resume must be correct')
    }
    report.cases.push({ changed, savedPrefix: paused.completedBytes, status: terminal.status, result })
    await engine.stop(); engine = null; await delay(900)
  }
  if (process.argv.includes('--post-only')) {
    engine = await boot('post-state')
    let rejection
    const added = await engine.request('add', { url: `http://127.0.0.1:${server.address().port}/post.bin`,
      filename: 'post.bin', folderPath: join(root, 'downloads'), method: 'POST', body: 'fixture=form', connections: 1 }).catch(error => { rejection = error.message; return { ok: false } })
    if (process.argv.includes('--expect-post-rejected')) {
      assert.equal(added.ok, false)
      assert.match(rejection ?? '', /非 GET/)
      assert.equal(requests.length, 0)
      assert.deepEqual((await engine.request('list')).tasks, [])
    }
    const terminal = added.ok ? await task(added.task.id, t => ['complete', 'error'].includes(t.status)) : null
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
