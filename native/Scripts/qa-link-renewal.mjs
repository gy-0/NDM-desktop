#!/usr/bin/env node
// Real NDMHost + local HTTP regression, isolated from the installed application.
// Usage: node native/Scripts/qa-link-renewal.mjs --host /path/to/NDMHost --expect baseline|protected
// Reports and all synthetic payloads remain in the printed /tmp directory.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createTCPServer, createConnection } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, stat, rename, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const hostPath = resolve(argument('--host', join(dirname(fileURLToPath(import.meta.url)), '../.build/debug/NDMHost')))
const expectation = argument('--expect', 'protected')
assert.ok(['baseline', 'protected'].includes(expectation), '--expect must be baseline or protected')
const root = await mkdtemp('/tmp/ndm-link-renewal-')
const report = { expectation, hostPath, root, source: {}, cases: [] }
const bytes = 8 * 1024 * 1024
const sourceA = Buffer.alloc(bytes)
const sourceB = Buffer.alloc(bytes)
for (let index = 0; index < bytes; index++) {
  sourceA[index] = (index * 31 + Math.floor(index / 251) * 17 + 19) % 256
  sourceB[index] = sourceA[index] ^ 0xa5
}
const sha256 = data => createHash('sha256').update(data).digest('hex')
report.source = { size: bytes, aSHA256: sha256(sourceA), bSHA256: sha256(sourceB), etag: '"same-validator-different-uris"' }
// Freeze one executable for all process restarts, even if another task rebuilds
// the supplied Swift product while this fixture is running.
const hostBinary = await readFile(hostPath)
report.hostSHA256 = sha256(hostBinary)
const frozenHostPath = join(root, 'NDMHost')
await writeFile(frozenHostPath, hostBinary)
await chmod(frozenHostPath, 0o755)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = async () => {
  const server = createTCPServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const waitFor = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(50)
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`)
}

let activeCase
const http = createServer((request, response) => {
  const test = activeCase
  const url = new URL(request.url, 'http://fixture.invalid')
  const payload = url.pathname.endsWith('object-b.bin') ? sourceB : sourceA
  const record = {
    phase: test.phase, method: request.method, url: request.url,
    range: request.headers.range ?? null, ifRange: request.headers['if-range'] ?? null,
    fixtureHeader: request.headers['x-ndm-fixture'] ?? null,
    status: 0, start: 0, end: 0, bodyBytesWritten: 0
  }
  test.requests.push(record)
  if (test.expired && url.searchParams.get('token') === 'old') {
    record.status = 403
    response.writeHead(403, { 'content-type': 'text/plain', 'content-length': '7' })
    response.end('expired')
    return
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  const start = match ? Number(match[1]) : 0
  const end = match && match[2] ? Math.min(bytes - 1, Number(match[2])) : bytes - 1
  if (start > end || start >= bytes) {
    record.status = 416
    response.writeHead(416, { 'content-range': `bytes */${bytes}` })
    response.end()
    return
  }
  const headers = {
    'accept-ranges': 'bytes', etag: report.source.etag,
    'content-type': 'application/octet-stream', 'content-length': String(end - start + 1)
  }
  if (match) headers['content-range'] = `bytes ${start}-${end}/${bytes}`
  Object.assign(record, { status: match ? 206 : 200, start, end })
  response.writeHead(record.status, headers)
  if (request.method === 'HEAD') { response.end(); return }
  let cursor = start
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) { clearInterval(timer); return }
    const next = Math.min(cursor + 64 * 1024, end + 1)
    const chunk = payload.subarray(cursor, next)
    cursor = next
    // These are origin HTTP response body bytes written to the local socket;
    // saved/retained bytes are measured separately from the actual partial file.
    response.write(chunk, error => { if (!error) record.bodyBytesWritten += chunk.length })
    if (cursor > end) { clearInterval(timer); response.end() }
  }, 20)
  response.on('close', () => clearInterval(timer))
})
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${http.address().port}`

class Host {
  constructor(support, port, bridgePort) {
    Object.assign(this, { support, port, bridgePort, sequence: 0, pending: new Map(), logs: '' })
  }
  async start() {
    for (let attempt = 0; ; attempt++) {
      const logStart = this.logs.length
      this.child = spawn(frozenHostPath, [], { env: {
        ...process.env, NDM_SUPPORT_DIR: this.support, NDM_HOST_PORT: String(this.port),
        NDM_BRIDGE_PORT: String(this.bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1'
      }, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child.stdout.on('data', data => { this.logs += data })
      this.child.stderr.on('data', data => { this.logs += data })
      try {
        await waitFor(async () => {
          if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`NDMHost exited: ${this.logs.slice(logStart)}`)
          // A free-port query cannot reserve that port across exec. Confirm the
          // listener belongs to our child before sending any mutating Host RPC;
          // concurrent native tests can otherwise win the bind race.
          try {
            const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(this.child.pid), '-iTCP:' + this.port, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
            return listeners.split('\n').includes('p' + this.child.pid)
          } catch (error) {
            if (error.status === 1) return false
            throw error
          }
        }, 'listener owned by isolated Host process')
        break
      } catch (error) {
        await this.stop()
        if (attempt >= 9 || !this.logs.slice(logStart).includes('Address already in use')) throw error
        this.port = await freePort()
        this.bridgePort = await freePort()
      }
    }
    this.socket = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: this.port })
      socket.once('error', reject)
      socket.once('connect', () => resolve(socket))
    })
    assert.equal(this.child.exitCode, null, 'isolated Host must remain alive before RPC')
    assert.equal(this.child.signalCode, null, 'isolated Host must remain alive before RPC')
    let buffer = ''
    this.socket.on('data', data => {
      buffer += data
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const reply = JSON.parse(line)
        if (this.pending.has(reply.id)) {
          this.pending.get(reply.id)(reply)
          this.pending.delete(reply.id)
        }
      }
    })
    this.socket.on('error', () => {})
    assert.equal((await this.request('ping')).ok, true)
  }
  async request(op, fields = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${op}`)) }, 30000)
      this.pending.set(id, value => { clearTimeout(timer); resolve(value) })
      this.socket.write(JSON.stringify({ id, op, ...fields }) + '\n')
    })
  }
  async task(id) { return (await this.request('list')).tasks.find(task => task.id === id) }
  async stop() {
    this.socket?.destroy()
    if (this.child?.exitCode === null && this.child?.signalCode === null) {
      const done = new Promise(resolve => this.child.once('exit', resolve))
      this.child.kill('SIGTERM')
      await done
    }
  }
}

const persistedTask = (support, taskID) => {
  const sql = `SELECT id,url,method,status,useragent,pageurl,postdata,urla,ltype,errortext,lasttry FROM downloads WHERE id=${Number(taskID)};`
  const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', join(support, 'NeatDB.db'), sql], { encoding: 'utf8' }))
  const headers = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', join(support, 'NeatDB.db'), `SELECT header FROM headers WHERE id=${Number(taskID)} ORDER BY header;`], { encoding: 'utf8' }) || '[]')
  return { ...rows[0], headers: headers.map(row => row.header) }
}

const checkpoint = async (test, taskID, stage) => {
  if (test.backend === 'legacy') {
    const work = join(test.support, String(taskID))
    const metadata = await readFile(join(work, 'segments.bin'))
    const identity = await readFile(join(work, 'representation.json'))
    const ranges = []
    const saved = []
    for (let offset = 0; offset < metadata.length; offset += 24) {
      const id = metadata.readInt16LE(offset + 2)
      const start = Number(metadata.readBigInt64LE(offset + 8))
      const end = Number(metadata.readBigInt64LE(offset + 16))
      const content = await readFile(join(work, `seg.x${id}`))
      assert.equal(sha256(content), sha256(sourceA.subarray(start, start + content.length)))
      saved.push(content)
      ranges.push({ id, start, end, durablePrefix: content.length, savedSHA256: sha256(content) })
    }
    const result = {
      partialPath: work, partialSHA256: sha256(Buffer.concat(saved)),
      manifestSHA256: sha256(Buffer.concat([metadata, identity])),
      durableBytes: saved.reduce((sum, content) => sum + content.length, 0), ranges
    }
    await writeFile(join(test.directory, `${stage}-checkpoint.json`), JSON.stringify(result, null, 2))
    return result
  }
  const manifestPath = join(test.support, String(taskID), 'offset-storage-v2.json')
  const manifestData = await readFile(manifestPath)
  const manifest = JSON.parse(manifestData)
  const partialPath = join(manifest.parentPath, manifest.partialName)
  assert.ok(partialPath.startsWith(test.directory + '/'), 'fixture may only read its own synthetic partial')
  const partial = await readFile(partialPath)
  const ranges = manifest.ranges.map(range => {
    const stored = partial.subarray(range.start, range.start + range.durablePrefix)
    assert.equal(sha256(stored), sha256(sourceA.subarray(range.start, range.start + range.durablePrefix)), 'saved bytes must be object A')
    return { ...range, savedSHA256: sha256(stored) }
  })
  const file = await stat(partialPath)
  const result = {
    partialPath, fileSize: file.size, allocatedBytes: file.blocks * 512,
    partialSHA256: sha256(partial), manifestSHA256: sha256(manifestData),
    durableBytes: ranges.reduce((sum, range) => sum + range.durablePrefix, 0), ranges
  }
  await writeFile(join(test.directory, `${stage}-checkpoint.json`), JSON.stringify({ ...result, manifest }, null, 2))
  return result
}

// Compatibility fixture conversion: these are bytes acquired by the real v2
// engine in this run, translated to the documented historical 24-byte records.
// No new identity is invented; the engine-written representation.json remains.
const convertActualCheckpointToLegacy = async (test, taskID) => {
  const work = join(test.support, String(taskID))
  const manifestPath = join(work, 'offset-storage-v2.json')
  const manifest = JSON.parse(await readFile(manifestPath))
  const partialPath = join(manifest.parentPath, manifest.partialName)
  assert.ok(partialPath.startsWith((test.artifactRoot ?? test.directory) + '/'))
  const content = await readFile(partialPath)
  const ranges = [...manifest.ranges].sort((a, b) => a.start - b.start)
  const metadata = Buffer.alloc(24 * ranges.length)
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    const offset = 24 * index
    metadata.writeInt16LE(index, offset)
    metadata.writeInt16LE(range.id, offset + 2)
    metadata.writeInt32LE(ranges[index + 1]?.id ?? -1, offset + 4)
    metadata.writeBigInt64LE(BigInt(range.start), offset + 8)
    metadata.writeBigInt64LE(BigInt(range.end), offset + 16)
    await writeFile(join(work, `seg.x${range.id}`), content.subarray(range.start, range.start + range.durablePrefix))
  }
  await writeFile(join(work, 'segments.bin'), metadata)
  // Retain the complete input evidence outside engine-owned work directories.
  await rename(manifestPath, join(test.directory, 'conversion-input-offset-storage-v2.json'))
  await rename(partialPath, join(test.directory, 'conversion-input.partial'))
  test.conversion = 'Real downloaded v2 durable prefixes copied into documented legacy segment records; original representation.json preserved unchanged.'
}
const assertSameCheckpoint = (before, after) => {
  assert.equal(after.partialPath, before.partialPath, 'partial ownership path changed')
  assert.equal(after.partialSHA256, before.partialSHA256, 'existing bytes changed')
  assert.equal(after.manifestSHA256, before.manifestSHA256, 'durable ownership metadata changed')
  assert.equal(after.durableBytes, before.durableBytes)
}

let runningHost
try {
  for (const backend of ['v2', 'legacy']) {
   for (const candidateKind of ['same-object-new-token', 'different-object-same-size-etag']) {
    const directory = join(root, `${backend}-${candidateKind}`)
    const support = join(directory, 'support')
    const destination = join(directory, 'downloads')
    await mkdir(destination, { recursive: true })
    activeCase = { name: candidateKind, backend: 'v2', directory, support, phase: 'initial', expired: false, requests: [] }
    const test = activeCase
    report.cases.push(test)
    const host = new Host(support, await freePort(), await freePort())
    runningHost = host
    await host.start()
    assert.equal((await host.request('updateSettings', {
      downloadDirectory: destination, maxConnections: 1, smartConnections: false,
      bandwidthLimitBytesPerSecond: 0, useCategoryFolders: false, askBrowserDownloadDestination: true
    })).ok, true)
    const oldURL = `${baseURL}/${candidateKind}/object-a.bin?token=old`
    const newURL = `${baseURL}/${candidateKind}/${candidateKind.startsWith('same-') ? 'object-a' : 'object-b'}.bin?token=new`
    const pageURL = `${baseURL}/source-with-multiple-files`
    const created = await host.request('add', {
      url: oldURL, pageURL, filename: 'download.bin', connections: 1,
      folderPath: destination, headers: ['X-NDM-Fixture: original-context'], autoStart: true
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const taskID = created.task.id
    test.taskID = taskID
    await waitFor(async () => {
      const task = await host.task(taskID)
      if (task.status === 'error') throw new Error(JSON.stringify(task))
      return task.completedBytes >= 1024 * 1024
    }, 'at least 1 MiB genuinely downloaded')
    assert.equal((await host.request('pause', { taskID })).ok, true)
    await waitFor(async () => (await host.task(taskID)).status === 'paused', 'paused task')
    await sleep(200)
    if (backend === 'legacy') {
      test.beforeConversion = await checkpoint(test, taskID, 'before-conversion')
      await host.stop()
      await convertActualCheckpointToLegacy(test, taskID)
      test.backend = 'legacy'
      await host.start()
    }
    test.before = await checkpoint(test, taskID, 'before')
    assert.ok(test.before.durableBytes > 0 && test.before.durableBytes < bytes)
    test.originalPersisted = persistedTask(support, taskID)

    test.phase = 'expired-resume'
    test.expired = true
    assert.equal((await host.request('resume', { taskID })).ok, true)
    test.expiredTask = await waitFor(async () => {
      const task = await host.task(taskID)
      return task.status === 'error' && task
    }, 'HTTP 403 stops expired original URL')
    test.afterExpiry = await checkpoint(test, taskID, 'after-expiry')
    assertSameCheckpoint(test.before, test.afterExpiry)
    test.expiredPersisted = persistedTask(support, taskID)

    test.phase = 'candidate-renewal'
    test.renewal = await host.request('renew', { taskID, url: newURL, autoStart: false })
    test.afterRenewal = await checkpoint(test, taskID, 'after-renewal')
    assertSameCheckpoint(test.before, test.afterRenewal)
    if (expectation === 'baseline') {
      assert.equal(test.renewal.ok, true, JSON.stringify(test.renewal))
      assert.equal(test.renewal.task.url, newURL)
      test.phase = 'candidate-resume'
      assert.equal((await host.request('resume', { taskID })).ok, true)
      test.candidateTask = await waitFor(async () => {
        const task = await host.task(taskID)
        return (backend === 'v2' ? task.status === 'error' : task.status === 'complete') && task
      }, 'baseline replacement reaches observed backend outcome')
      if (backend === 'legacy') {
        await sleep(100)
        test.outputSHA256 = sha256(await readFile(join(destination, test.candidateTask.filename)))
        assert.equal(test.outputSHA256, candidateKind.startsWith('same-') ? report.source.aSHA256 : report.source.bSHA256)
        const dataRequests = test.requests.filter(request => request.phase === 'candidate-resume' && request.method === 'GET' && request.status < 400 && request.end > request.start)
        test.replacementTransfer = {
          originDataBodyBytesWritten: dataRequests.reduce((sum, request) => sum + request.bodyBytesWritten, 0),
          previouslySavedBytes: test.before.durableBytes,
          reusedOldBytes: 0,
          repeatedDownloadedOffsets: dataRequests.reduce((sum, request) => sum + test.before.ranges.reduce((total, range) => total + Math.max(0, Math.min(request.start + request.bodyBytesWritten, range.start + range.durablePrefix) - Math.max(request.start, range.start)), 0), 0)
        }
        assert.equal(test.replacementTransfer.originDataBodyBytesWritten, bytes, 'legacy baseline silently downloads the complete replacement')
        assert.equal(test.replacementTransfer.repeatedDownloadedOffsets, test.before.durableBytes)
        await host.stop()
        runningHost = null
        await writeFile(join(directory, 'host.log'), host.logs)
        console.log(JSON.stringify({ backend, case: candidateKind, renewalAccepted: test.renewal.ok, replacementTransfer: test.replacementTransfer, outputSHA256: test.outputSHA256 }))
        continue
      }
      test.afterCandidateResume = await checkpoint(test, taskID, 'after-candidate-resume')
      assertSameCheckpoint(test.before, test.afterCandidateResume)
    } else {
      assert.equal(test.renewal.ok, false, 'identity-ambiguous new URL must be rejected before changing task')
      assert.equal((await host.task(taskID)).url, oldURL)
      assert.deepEqual(persistedTask(support, taskID), test.expiredPersisted, 'rejected renewal must not mutate stored request, status, or error')
      assert.equal(test.requests.filter(request => request.phase === 'candidate-renewal').length, 0, 'rejection should not fetch ambiguous replacement')
    }

    await host.stop()
    await host.start()
    test.afterRestartTask = await host.task(taskID)
    test.afterRestartPersisted = persistedTask(support, taskID)
    test.afterRestart = await checkpoint(test, taskID, 'after-restart')
    assertSameCheckpoint(test.before, test.afterRestart)
    assert.deepEqual(test.afterRestartPersisted.headers, test.originalPersisted.headers)
    assert.equal(test.afterRestartTask.url, expectation === 'baseline' ? newURL : oldURL)
    if (expectation === 'baseline') {
      // Repair only this disposable fixture's overwritten URL, to measure
      // whether its untouched original byte ranges can still be recovered.
      assert.equal((await host.request('renew', { taskID, url: oldURL, autoStart: false })).ok, true)
    }

    test.expired = false
    test.phase = 'same-url-resume'
    const unchangedRenewal = await host.request('renew', { taskID, url: oldURL, autoStart: false })
    assert.equal(unchangedRenewal.ok, true, JSON.stringify(unchangedRenewal))
    assert.equal((await host.request('resume', { taskID })).ok, true)
    test.completeTask = await waitFor(async () => {
      const task = await host.task(taskID)
      if (task.status === 'error') throw new Error(`Same URL recovery failed: ${JSON.stringify(task)}`)
      return task.status === 'complete' && task
    }, 'same URL resumes missing bytes and completes')
    await sleep(100)
    const completed = await readFile(join(destination, test.completeTask.filename))
    test.outputSHA256 = sha256(completed)
    assert.equal(test.outputSHA256, report.source.aSHA256)
    const payloadRequests = test.requests.filter(request => request.phase === 'same-url-resume' && request.method === 'GET' && request.status < 400)
    const dataRequests = payloadRequests.filter(request => request.end > request.start)
    const initialDataRequests = test.requests.filter(request => request.phase === 'initial' && request.method === 'GET' && request.status < 400 && request.end > request.start)
    const overlap = (start, end, range) => Math.max(0, Math.min(end + 1, range.start + range.durablePrefix) - Math.max(start, range.start))
    test.reuse = {
      durableBytesReused: test.before.durableBytes,
      expectedMissingBytes: bytes - test.before.durableBytes,
      originBodyBytesWritten: payloadRequests.reduce((sum, request) => sum + request.bodyBytesWritten, 0),
      originDataBodyBytesWritten: dataRequests.reduce((sum, request) => sum + request.bodyBytesWritten, 0),
      repeatedSavedDataBytes: dataRequests.reduce((sum, request) => sum + test.before.ranges.reduce((total, range) => total + overlap(request.start, request.start + request.bodyBytesWritten - 1, range), 0), 0),
      // Socket bytes sent shortly before pause can exceed the durable prefix.
      // Count their inevitable retransmission separately from wasted re-fetches
      // of genuinely saved bytes; never report all network duplication as zero.
      repeatedOriginDataOffsets: dataRequests.reduce((sum, request) => sum + initialDataRequests.reduce((total, initial) => total + overlap(request.start, request.start + request.bodyBytesWritten - 1, { start: initial.start, durablePrefix: initial.bodyBytesWritten }), 0), 0)
    }
    assert.equal(test.reuse.repeatedSavedDataBytes, 0, 'real resumed data requests must not download saved bytes again')
    assert.equal(test.reuse.originDataBodyBytesWritten, test.reuse.expectedMissingBytes)
    assert.ok(dataRequests.every(request => request.ifRange === report.source.etag), 'If-Range remains enforced')
    assert.ok(payloadRequests.every(request => request.fixtureHeader === 'original-context'), 'original header survives renewal rejection and process restart')
    if (expectation === 'protected' && candidateKind === 'same-object-new-token') {
      // A second real partial proves rejecting renewal does not detach the
      // ownership record needed by later user cancellation/removal.
      test.phase = 'cancellation-setup'
      const cancelCreated = await host.request('add', {
        url: oldURL, pageURL, filename: 'cancel.bin', connections: 1,
        folderPath: destination, headers: ['X-NDM-Fixture: original-context'], autoStart: true
      })
      assert.equal(cancelCreated.ok, true, JSON.stringify(cancelCreated))
      const cancelID = cancelCreated.task.id
      await waitFor(async () => (await host.task(cancelID)).completedBytes >= 1024 * 1024, 'cancellation partial')
      assert.equal((await host.request('pause', { taskID: cancelID })).ok, true)
      await waitFor(async () => (await host.task(cancelID)).status === 'paused', 'cancellation paused')
      await sleep(200)
      if (backend === 'legacy') {
        await host.stop()
        // Separate evidence names keep the first conversion inputs intact.
        const cancellationEvidence = { ...test, directory: join(directory, 'cancellation-evidence') }
        await mkdir(cancellationEvidence.directory)
        // Ownership guard must also include the actual disposable download dir.
        await convertActualCheckpointToLegacy({ ...cancellationEvidence, artifactRoot: directory }, cancelID)
        await host.start()
      }
      const cancelBefore = await checkpoint(test, cancelID, 'before-cancellation')
      const rejection = await host.request('renew', { taskID: cancelID, url: newURL, autoStart: false })
      assert.equal(rejection.ok, false)
      await host.stop()
      await host.start()
      assertSameCheckpoint(cancelBefore, await checkpoint(test, cancelID, 'cancellation-after-restart'))
      const sentinelPath = join(destination, 'unrelated-fixture-sentinel.txt')
      const sentinel = 'owned by the fixture user, not by a download task'
      await writeFile(sentinelPath, sentinel)
      const removed = await host.request('remove', { taskID: cancelID, deleteFile: false })
      assert.equal(removed.ok, true, JSON.stringify(removed))
      assert.equal(await host.task(cancelID), undefined)
      assert.equal(await stat(join(support, String(cancelID))).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
      if (backend === 'v2') assert.equal(await stat(cancelBefore.partialPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
      assert.equal(await readFile(sentinelPath, 'utf8'), sentinel)
      test.cancellation = { taskID: cancelID, bytesRetainedUntilRemoval: cancelBefore.durableBytes, ownedArtifactsRemoved: true, unrelatedFileUnchanged: true }
    }
    await host.stop()
    runningHost = null
    await writeFile(join(directory, 'host.log'), host.logs)
    console.log(JSON.stringify({ backend, case: candidateKind, renewalAccepted: test.renewal.ok, bytesRetained: test.before.durableBytes, reuse: test.reuse, outputSHA256: test.outputSHA256 }))
   }
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  process.exitCode = 1
  console.error(error)
} finally {
  if (runningHost) {
    await runningHost.stop()
    await writeFile(join(root, 'failed-host.log'), runningHost.logs)
  }
  http.closeAllConnections()
  await new Promise(resolve => http.close(resolve))
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(root, 'report.json')}`)
}
