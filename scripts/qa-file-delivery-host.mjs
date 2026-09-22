// Real Host name reservations, collision safety and restart continuity.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-file-delivery-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
const payloads = { '/a.bin': Buffer.alloc(1024 * 1024, 0x61), '/b.bin': Buffer.alloc(1024 * 1024, 0x62) }
const lateOriginal = Buffer.from('File created by another app during transfer')
let lateCollision = false
const transfers = []; let generation = 1
const server = createServer((req, res) => {
  transfers.push({ path: req.url, method: req.method, range: req.headers.range, generation })
  const payload = payloads[req.url]
  if (req.url === '/race.bin' && req.method === 'GET' && req.headers.range !== 'bytes=0-0' && !lateCollision) {
    lateCollision = true
    writeFileSync(join(downloads, 'late-file.bin'), lateOriginal)
  }
  if (!payload) { res.writeHead(404); res.end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="server-name.bin"', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: `"${req.url}"`, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
let exited = once(host, 'exit')
let seq = 0
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = ++seq, socket = createConnection({ host: '127.0.0.1', port: hostPort })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Host ${op} timeout`)) }, 12000)
  let buffer = ''
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ ...extra, op, id }) + '\n'))
  socket.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    let reply; try { reply = JSON.parse(line) } catch { continue }
    if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolve(reply); return }
  } })
})
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, categorySubfolders: false, downloadAllAtOnce: true })).ok, true)
  const original = Buffer.from('Existing user file must survive')
  const results = []
  const complete = async ids => until('downloads complete', async () => {
    const tasks = (await request('list')).tasks.filter(task => ids.includes(task.id))
    assert.ok(tasks.every(task => task.status !== 'error'), JSON.stringify(tasks.map(task => ({ id: task.id, error: task.errorText }))))
    return tasks.length === ids.length && tasks.every(task => task.status === 'complete') ? tasks : null
  })
  for (const scenario of [
    { name: 'existing', filename: 'same-name.bin', seed: true },
    { name: 'concurrent', filename: 'parallel.bin', seed: false },
    { name: 'server-metadata', filename: 'server-name.bin', seed: true, metadata: true }
  ]) {
    const existingPath = join(downloads, scenario.filename)
    if (scenario.seed) await writeFile(existingPath, original)
    const replies = await Promise.all(Object.keys(payloads).map(path => request('add', { url: base + path,
      ...(scenario.metadata ? {} : { filename: scenario.filename }), folderPath: downloads, connections: 4, autoStart: true })))
    assert.ok(replies.every(reply => reply.ok && reply.task?.id))
    const completed = await complete(replies.map(reply => reply.task.id))
    if (scenario.seed) assert.deepEqual(await readFile(existingPath), original)
    assert.equal(new Set(completed.map(task => join(task.folderPath, task.filename))).size, 2)
    for (const task of completed) {
      if (scenario.seed) assert.notEqual(join(task.folderPath, task.filename), existingPath)
      assert.deepEqual(await readFile(join(task.folderPath, task.filename)), payloads[new URL(task.url).pathname])
    }
    results.push({ scenario: scenario.name, filenames: completed.map(task => task.filename) })
  }
  // A numbered destination must survive pause, host shutdown and receipt recovery.
  const resumeOriginal = join(downloads, 'resume.bin')
  await writeFile(resumeOriginal, original)
  assert.equal((await request('updateSettings', { bandwidthLimitBytesPerSecond: 131072 })).ok, true)
  const resumedID = (await request('add', { url: base + '/a.bin', filename: 'resume.bin', folderPath: downloads, connections: 1, autoStart: true })).task.id
  const progress = await until('numbered download progress', async () => {
    const task = (await request('list')).tasks.find(task => task.id === resumedID)
    assert.notEqual(task?.status, 'error')
    return task?.completedBytes > 0 && task.status === 'downloading' ? task : null
  })
  assert.equal(progress.filename, 'resume (2).bin')
  assert.equal((await request('pause', { taskID: resumedID })).ok, true)
  const paused = (await request('list')).tasks.find(task => task.id === resumedID)
  assert.ok(paused.completedBytes > 0 && paused.completedBytes < payloads['/a.bin'].length)
  const receiptPath = join(support, String(resumedID), 'offset-storage-v2.json')
  const receiptBytes = await readFile(receiptPath)
  const receipt = JSON.parse(receiptBytes)
  const durablePrefixBytes = receipt.ranges.reduce((sum, range) => sum + range.durablePrefix, 0)
  assert.ok(durablePrefixBytes > 0)
  const partial = join(receipt.parentPath, receipt.partialName), partialBytes = await readFile(partial)
  host.kill('SIGTERM'); await exited
  generation = 2
  host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
  exited = once(host, 'exit')
  await until('restarted host', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  const restored = (await request('list')).tasks.find(task => task.id === resumedID)
  assert.equal(restored.filename, paused.filename)
  assert.equal(restored.status, 'paused')
  assert.deepEqual(await readFile(receiptPath), receiptBytes)
  assert.deepEqual(await readFile(partial), partialBytes)
  assert.equal((await request('updateSettings', { bandwidthLimitBytesPerSecond: 0 })).ok, true)
  assert.equal((await request('resume', { taskID: resumedID })).ok, true)
  const [finished] = await complete([resumedID])
  assert.equal(finished.filename, paused.filename)
  assert.deepEqual(await readFile(join(finished.folderPath, finished.filename)), payloads['/a.bin'])
  assert.deepEqual(await readFile(resumeOriginal), original)
  assert.ok(transfers.some(row => row.generation === 2 && row.method === 'GET' && row.range?.startsWith(`bytes=${durablePrefixBytes}-`)), 'Resume must begin at the exact retained prefix')
  const replacement = Buffer.alloc(payloads['/a.bin'].length, 0x63)
  payloads['/a.bin'] = replacement
  assert.equal((await request('restart', { taskID: resumedID })).ok, true)
  const [redownloaded] = await complete([resumedID])
  assert.equal(redownloaded.filename, finished.filename)
  assert.deepEqual(await readFile(join(redownloaded.folderPath, redownloaded.filename)), replacement)
  assert.deepEqual(await readFile(resumeOriginal), original)
  await writeFile(join(downloads, 'mirror.bin'), original)
  const mirrored = await request('add', { url: base + '/missing.bin', mirrors: [base + '/b.bin'], filename: 'mirror.bin', folderPath: downloads, autoStart: true })
  assert.equal(mirrored.ok, true)
  const [mirrorFinished] = await complete([mirrored.task.id])
  assert.equal(mirrorFinished.filename, 'mirror (2).bin')
  assert.deepEqual(await readFile(join(downloads, 'mirror.bin')), original)
  assert.deepEqual(await readFile(join(mirrorFinished.folderPath, mirrorFinished.filename)), payloads['/b.bin'])
  payloads['/race.bin'] = Buffer.alloc(1024 * 1024, 0x64)
  const late = await request('add', { url: base + '/race.bin', filename: 'late-file.bin', folderPath: downloads, autoStart: true })
  assert.equal(late.ok, true)
  const lateTask = await until('late collision rejection', async () => {
    const task = (await request('list')).tasks.find(task => task.id === late.task.id)
    return task?.status === 'error' || task?.status === 'complete' ? task : null
  })
  assert.equal(lateTask.status, 'error')
  assert.equal(lateTask.errorText, '#diag:fileAlreadyExists')
  assert.deepEqual(await readFile(join(downloads, 'late-file.bin')), lateOriginal)
  console.log(JSON.stringify({ passed: true, scenarios: results, lateExternalCollisionPreserved: true, explicitRedownloadKeepsDestination: true, mirrorCollisionResolved: true, numberedResumeAfterRestart: true, preservedPrefixBytes: durablePrefixBytes, restoredListBytes: restored.completedBytes, existingFilesPreserved: true, exactBytes: true }))

} finally {
  await request('pauseAll').catch(() => {})
  host.kill('SIGTERM'); await exited
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
