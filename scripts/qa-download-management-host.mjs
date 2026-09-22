// Real native Host plus the main-process import, rules and schedule services.
// Only the schedule clock and OS secure-storage adapter use isolated QA inputs.
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-management-host-'))
const support = join(root, 'support'), downloads = join(root, 'downloads'), archives = join(root, 'archives')
for (const path of [support, downloads, archives]) await mkdir(path)
await build({ stdin: { contents: "export * from './src/main/downloadImport.ts'; export * from './src/main/directoryRules.ts'; export * from './src/main/bandwidthSchedule.ts'; export * from './src/main/fileIntegrity.ts'", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'services.mjs') })
const { DownloadImportService, DirectoryRulesService, BandwidthScheduleController, FileIntegrityService } = await import(pathToFileURL(join(root, 'services.mjs')).href)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate, attempts = 300) => {
  for (let i = 0; i < attempts; i++) { const result = await predicate(); if (result) return result; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payload = Buffer.alloc(2 * 1024 * 1024, 0x63), paths = []
const server = createServer((req, res) => {
  paths.push(req.url)
  if (req.url === '/missing.zip') { res.writeHead(404); res.end(); return }
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1
  res.writeHead(match ? 206 : 200, { 'Content-Type': 'application/zip', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"management-fixture"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
const exited = once(host, 'exit')
let sequence = 0
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port: hostPort })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Host ${op} timeout`)) }, 10000)
  let text = ''
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ ...extra, id, op }) + '\n'))
  socket.on('data', chunk => { text += chunk; for (let index; (index = text.indexOf('\n')) >= 0;) {
    const line = text.slice(0, index); text = text.slice(index + 1)
    let reply; try { reply = JSON.parse(line) } catch { continue }
    if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolve(reply); return }
  } })
})
let schedule, integrity
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, useCategoryFolders: false, downloadAllAtOnce: false, maxConnections: 1, bandwidthLimitBytesPerSecond: 0 })).ok, true)
  const rules = new DirectoryRulesService({ statePath: join(support, 'directory-rules.json'), platform: 'posix', chooseDirectory: async () => null,
    resolveFallbackDirectory: async sample => (await request('directoryRulesFallback', sample)).directory,
    applyConfig: async () => { assert.equal((await request('directoryRulesReload')).ok, true) } })
  assert.equal((await rules.request('directoryRulesSave', { expectedRevision: 0, config: { version: 1, enabled: true,
    rules: [{ id: 'archives', name: '压缩包', enabled: true, directory: archives, extensions: ['zip'], hosts: [], pathGlobs: [] }] } })).ok, true)
  assert.equal((await rules.request('directoryRulesResolve', { samples: [{ url: `${base}/first.zip` }] })).results[0].directory, archives)
  let clock = new Date(2026, 8, 14, 10, 30).getTime()
  schedule = new BandwidthScheduleController({ statePath: join(support, 'schedule.json'),
    clock: { now: () => clock, setTimer: () => 0, clearTimer: () => {} },
    readState: async () => ({ limitBytesPerSecond: (await request('getSettings')).settings.bandwidthLimitBytesPerSecond, temporaryActive: false }),
    writeLimit: bytes => request('updateSettings', { bandwidthLimitBytesPerSecond: bytes }) })
  await schedule.start()
  const scheduled = await schedule.handle('bandwidthScheduleSave', { expectedRevision: 0, enabled: true,
    rules: [{ id: 'weekday', name: '工作时段', enabled: true, days: [1], start: '10:00', end: '11:00', limitBytesPerSecond: 131072 }] })
  assert.equal(scheduled.state.appliedLimitBytesPerSecond, 131072)
  const source = join(root, 'tasks.aria2')
  await writeFile(source, `${base}/missing.zip\t${base}/first.zip\n  out=first.zip\n${base}/second.zip\n  out=second.zip\n${base}/third.zip\n  out=third.zip\n`)
  const key = randomBytes(32)
  const cipher = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), encoder = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([encoder.update(value), encoder.final()]); return Buffer.concat([iv, encoder.getAuthTag(), data]) },
    decryptString(value) { const decoder = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decoder.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString() } }
  const dependencies = { statePath: join(support, 'import.enc'), cipher, selectFile: async () => source,
    getCreationReceipt: creationKey => request('getCreationReceipt', { creationKey }), createDownload: options => request('add', options) }
  let importer = new DownloadImportService(dependencies)
  const preview = await importer.request('downloadImportPreview', { source: 'file' })
  assert.equal(preview.entries.length, 3); assert.equal((await request('list')).tasks.length, 0)
  assert.equal(paths.length, 0, 'Preview must not transfer data')
  const intent = { sessionID: preview.sessionID, itemIDs: preview.entries.map(row => row.id), autoStart: true }
  const created = await importer.request('downloadImportCreate', intent)
  assert.ok(created.results.every(result => result.status === 'accepted'), JSON.stringify(created))
  const ids = created.results.map(row => row.taskID)
  await until('waiting queue', async () => (await request('getWaitingQueue')).tasks.length === 2)
  const queue = await request('getWaitingQueue')
  assert.deepEqual(queue.tasks.map(task => task.id), ids.slice(1))
  const moved = await request('moveQueuedTask', { taskID: ids[2], beforeTaskID: ids[1], expectedIDs: ids.slice(1) })
  assert.deepEqual(moved.tasks.map(task => task.id), [ids[2], ids[1]])
  assert.equal((await request('moveQueuedTask', { taskID: ids[1], beforeTaskID: null, expectedIDs: ids.slice(1) })).ok, false)
  await until('first limited payload', async () => (await request('list')).tasks.find(task => task.id === ids[0])?.completedBytes > 0)
  await delay(1200)
  const limited = (await request('list')).tasks.find(task => task.id === ids[0])
  assert.notEqual(limited.status, 'complete'); assert.ok(limited.completedBytes < payload.length)
  clock = new Date(2026, 8, 14, 11, 1).getTime()
  await schedule.reconcile()
  assert.equal((await request('getSettings')).settings.bandwidthLimitBytesPerSecond, 0, 'Leaving window restores unlimited')
  await until('all artifacts', async () => (await request('list')).tasks.every(task => task.status === 'complete'))
  const tasks = (await request('list')).tasks
  for (const task of tasks) { assert.equal(task.folderPath, archives); assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payload) }
  assert.ok(paths.includes('/missing.zip') && paths.includes('/first.zip'))
  assert.ok(paths.indexOf('/third.zip') < paths.indexOf('/second.zip'), 'Queue reorder must change actual request admission order')
  importer = new DownloadImportService(dependencies)
  const replay = await importer.request('downloadImportCreate', intent)
  assert.deepEqual(replay.results.map(result => result.taskID), ids)
  assert.equal((await request('list')).tasks.length, 3)
  assert.ok(!(await readFile(dependencies.statePath)).includes(Buffer.from(base)))
  integrity = new FileIntegrityService({ resolveTask: async id => {
    const task = (await request('list')).tasks.find(task => task.id === id)
    return task ? { id: task.id, status: task.status, path: join(task.folderPath, task.filename) } : null
  } })
  const expectedDigest = createHash('sha256').update(payload).digest('hex')
  const check = async () => {
    const started = await integrity.handle('fileIntegrityStart', { taskID: ids[0], algorithm: 'sha256', expectedDigest })
    assert.equal(started.ok, true)
    return until('integrity result', async () => {
      const result = await integrity.handle('fileIntegrityStatus', { jobID: started.job.id })
      assert.equal(result.ok, true)
      return result.job.state !== 'running' ? result.job : null
    })
  }
  const verified = await check()
  assert.equal(verified.state, 'complete'); assert.equal(verified.matches, true)
  const first = tasks.find(task => task.id === ids[0]), file = join(first.folderPath, first.filename)
  assert.deepEqual(await readFile(file), payload, 'Verification must not change the downloaded bytes')
  const changed = Buffer.from(payload); changed[0] ^= 1
  await writeFile(file, changed)
  const stale = await integrity.handle('fileIntegrityStatus', { jobID: verified.id })
  assert.equal(stale.ok, true); assert.equal(stale.job.code, 'fileChanged')
  assert.equal(stale.job.digest, undefined); assert.equal(stale.job.matches, undefined)
  const mismatch = await check()
  assert.equal(mismatch.state, 'complete'); assert.equal(mismatch.matches, false)
  assert.deepEqual(await readFile(file), changed, 'Mismatch must preserve the file for the user')
  assert.deepEqual((await request('list')).tasks.map(task => [task.id, task.status]), tasks.map(task => [task.id, task.status]))
  const retryTarget = (await request('add', { url: `${base}/retry.zip`, filename: 'retry.zip', folderPath: archives, autoStart: false })).task
  assert.ok(retryTarget?.id)
  const partialRetry = await request('restartMany', { taskIDs: [retryTarget.id + 1000000, retryTarget.id] })
  assert.equal(partialRetry.ok, true)
  assert.equal(partialRetry.count, 1, 'One absent task must not be counted or block the valid task')
  const retried = await until('partial retry artifact', async () => {
    const task = (await request('list')).tasks.find(task => task.id === retryTarget.id)
    assert.notEqual(task?.status, 'error')
    return task?.status === 'complete' ? task : null
  })
  assert.deepEqual(await readFile(join(retried.folderPath, retried.filename)), payload)
  assert.equal((await request('list')).tasks.length, 4, 'Retry must not duplicate task records')
  assert.deepEqual(await readFile(file), changed, 'Retrying another task must not alter the earlier mismatched file')
  console.log(JSON.stringify({ passed: true, tasks: 4, previewZeroRequests: true, mirrorFallback: true, actualQueueOrder: [ids[0], ids[2], ids[1]],
    scheduleAppliedAndRestored: true, importRestartNoDuplicates: true, integrityMatch: true, staleIntegrityInvalidated: true, integrityMismatchPreservesFileAndTasks: true, partialRetryCount: partialRetry.count, partialRetryContinues: true, bytesPerArtifact: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }))
} finally {
  integrity?.dispose()
  await schedule?.stop()
  await request('pauseAll').catch(() => {})
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Only the owned fixture domain. */ }
  await rm(root, { recursive: true, force: true })
}
