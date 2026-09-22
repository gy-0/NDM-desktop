import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, open, rename, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { FileIntegrityService } from '../src/main/fileIntegrity.ts'
import { normalizeIntegrityDigest } from '../src/shared/fileIntegrity.ts'

const digest = (algorithm, payload) => createHash(algorithm).update(payload).digest('hex')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function fixture(t, payload = Buffer.from('NDM 文件校验\n'), options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-integrity-'))
  const path = join(root, 'fixture.bin')
  await writeFile(path, payload)
  const task = { id: 7, status: 'complete', path }
  const service = new FileIntegrityService({ resolveTask: async id => id === task.id ? task : null, ...options })
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) })
  return { root, path, task, service }
}

async function start(service, algorithm = 'sha256', extra = {}) {
  const result = await service.handle('fileIntegrityStart', { taskID: 7, algorithm, ...extra })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.job.state, 'running')
  return result.job
}

async function terminal(service, id, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await service.handle('fileIntegrityStatus', { jobID: id })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.job.state !== 'running') return result.job
    await sleep(2)
  }
  assert.fail('File integrity job did not finish within its deadline')
}

async function streamed(service, id) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { job } = await service.handle('fileIntegrityStatus', { jobID: id })
    if (job.completedBytes > 0) return job
    assert.equal(job.state, 'running')
    await sleep(1)
  }
  assert.fail('File stream made no progress')
}

test('file integrity streams real bytes for SHA-256, SHA-1 and MD5 without changing the file', async t => {
  const payload = Buffer.alloc(2 * 1024 * 1024)
  for (let offset = 0; offset < payload.length; offset++) payload[offset] = offset % 251
  const { service, path } = await fixture(t, payload)
  const before = await stat(path, { bigint: true })
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const job = await start(service, algorithm)
    const result = await terminal(service, job.id)
    assert.equal(result.state, 'complete')
    assert.equal(result.digest, digest(algorithm, payload))
    assert.equal(result.completedBytes, payload.length)
    assert.equal(result.totalBytes, payload.length)
    assert.equal(result.matches, undefined)
    assert.equal(Object.hasOwn(result, 'path'), false)
  }
  const after = await stat(path, { bigint: true })
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.equal(after.ctimeNs, before.ctimeNs)
  assert.deepEqual(await readFile(path), payload)
})

test('expected digests are strictly validated and comparisons distinguish a mismatch', async t => {
  const payload = Buffer.from('known file contents')
  const { service } = await fixture(t, payload)
  for (const invalid of ['a'.repeat(63), 'g'.repeat(64), 'sha256:' + 'a'.repeat(64), 'a'.repeat(64) + ' filename.bin']) {
    const reply = await service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256', expectedDigest: invalid })
    assert.equal(reply.code, 'invalidExpectedDigest')
  }
  assert.equal(normalizeIntegrityDigest('md5', '0'.repeat(32)), '0'.repeat(32))
  const correct = await start(service, 'sha256', { expectedDigest: ` ${digest('sha256', payload).toUpperCase()} ` })
  assert.equal((await terminal(service, correct.id)).matches, true)
  const wrong = await start(service, 'sha256', { expectedDigest: '0'.repeat(64) })
  const mismatch = await terminal(service, wrong.id)
  assert.equal(mismatch.state, 'complete')
  assert.equal(mismatch.matches, false)
  assert.equal(mismatch.digest, digest('sha256', payload))
})

test('an empty file has a valid completed digest', async t => {
  const { service } = await fixture(t, Buffer.alloc(0))
  const job = await start(service)
  const result = await terminal(service, job.id)
  assert.equal(result.state, 'complete')
  assert.equal(result.digest, digest('sha256', Buffer.alloc(0)))
  assert.equal(result.completedBytes, 0)
  assert.equal(result.totalBytes, 0)
})

test('paths only come from an existing completed task and cannot be supplied by callers', async t => {
  const { service, task, path } = await fixture(t)
  for (const extra of [{ taskID: 999 }, { taskID: '../7' }, { algorithm: 'sha512' }, { path }, { filename: 'elsewhere' }, { folderPath: '/' }]) {
    const reply = await service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256', ...extra })
    assert.equal(reply.ok, false)
  }
  task.status = 'downloading'
  assert.equal((await service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256' })).code, 'notCompleted')
  task.status = 'complete'
  task.path = 'relative.bin'
  assert.equal((await service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256' })).code, 'taskUnavailable')
  assert.deepEqual(await service.handle('fileIntegrityStatus', { taskID: 999 }), { ok: true, job: null })
})

test('cancelling after real stream progress stops work without a digest or a file write', async t => {
  const { service, path } = await fixture(t)
  const file = await open(path, 'r+')
  await file.truncate(64 * 1024 * 1024)
  await file.close()
  const before = await stat(path, { bigint: true })
  const job = await start(service)
  const progress = await streamed(service, job.id)
  assert.ok(progress.completedBytes < progress.totalBytes)
  const cancelled = await service.handle('fileIntegrityCancel', { jobID: job.id })
  assert.equal(cancelled.job.state, 'cancelled')
  await sleep(20)
  const result = await terminal(service, job.id)
  assert.equal(result.state, 'cancelled')
  assert.equal(result.digest, undefined)
  assert.ok(result.completedBytes < result.totalBytes)
  const after = await stat(path, { bigint: true })
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.equal(after.ctimeNs, before.ctimeNs)
})

test('file changes during hashing invalidate the result, including same-size replacement', async t => {
  for (const mode of ['rewrite', 'replace', 'append', 'taskRestart']) {
    const payload = Buffer.alloc(512 * 1024, 0x61)
    const { root, path, task } = await fixture(t, payload)
    let resolutions = 0
    const service = new FileIntegrityService({ resolveTask: async () => {
      resolutions++
      if (resolutions === 2) {
        if (mode === 'rewrite') await writeFile(path, Buffer.alloc(payload.length, 0x62))
        if (mode === 'replace') {
          const replacement = join(root, 'replacement.bin')
          await writeFile(replacement, payload)
          // Windows cannot rename over an open destination; moving the old
          // file aside still exercises replacement while its handle is open.
          await rename(path, join(root, 'previous.bin'))
          await rename(replacement, path)
        }
        if (mode === 'append') await writeFile(path, Buffer.from('extra'), { flag: 'a' })
        if (mode === 'taskRestart') task.status = 'downloading'
      }
      return task
    } })
    t.after(() => service.dispose())
    const job = await start(service)
    const result = await terminal(service, job.id)
    assert.equal(result.state, 'error', mode)
    assert.equal(result.code, 'fileChanged', mode)
    assert.equal(result.digest, undefined, mode)
    assert.equal(result.matches, undefined, mode)
  }
})

test('a file appended while streaming never produces a successful or unbounded hash', async t => {
  const { service, path } = await fixture(t)
  const file = await open(path, 'r+')
  await file.truncate(64 * 1024 * 1024)
  await file.close()
  const job = await start(service)
  const progress = await streamed(service, job.id)
  assert.ok(progress.completedBytes < progress.totalBytes)
  await writeFile(path, Buffer.from('appended while hashing'), { flag: 'a' })
  const result = await terminal(service, job.id)
  assert.equal(result.state, 'error')
  assert.equal(result.code, 'fileChanged')
  assert.equal(result.digest, undefined)
  assert.equal(result.completedBytes, 64 * 1024 * 1024)
})

test('restored completed results are invalidated if the file subsequently changes', async t => {
  const { service, path } = await fixture(t)
  const job = await start(service)
  assert.equal((await terminal(service, job.id)).state, 'complete')
  await writeFile(path, 'new version of the file')
  const { job: restored } = await service.handle('fileIntegrityStatus', { taskID: 7 })
  assert.equal(restored.state, 'error')
  assert.equal(restored.code, 'fileChanged')
  assert.equal(restored.digest, undefined)
})

test('directories, symlinks and FIFOs fail promptly without opening a blocking stream', async t => {
  const { service, task, root, path } = await fixture(t)
  const cases = [root]
  if (process.platform !== 'win32') {
    const link = join(root, 'link.bin')
    await symlink(path, link)
    const fifo = join(root, 'pipe.bin')
    execFileSync('mkfifo', [fifo])
    cases.push(link, fifo)
  }
  for (const target of cases) {
    task.path = target
    const job = await start(service)
    const result = await terminal(service, job.id, 1000)
    assert.equal(result.state, 'error')
    assert.equal(result.code, 'notRegularFile')
  }
  task.path = join(root, 'missing.bin')
  const job = await start(service)
  assert.equal((await terminal(service, job.id)).code, 'fileMissing')
})

test('concurrency includes unresolved starts, retention is bounded, and disposal cancels work', async t => {
  const { task } = await fixture(t)
  let release
  let first = true
  const service = new FileIntegrityService({ maxConcurrent: 1, maxJobs: 2, resolveTask: async () => {
    if (first) { first = false; await new Promise(resolve => { release = resolve }) }
    return task
  } })
  t.after(() => service.dispose())
  const pending = service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256' })
  assert.equal((await service.handle('fileIntegrityStart', { taskID: 8, algorithm: 'sha256' })).code, 'busy')
  release()
  const firstJob = (await pending).job
  await terminal(service, firstJob.id)
  for (const algorithm of ['sha1', 'md5']) {
    const job = await start(service, algorithm)
    await terminal(service, job.id)
  }
  assert.equal((await service.handle('fileIntegrityStatus', { jobID: firstJob.id })).code, 'jobNotFound')
  const job = await start(service)
  service.dispose()
  assert.equal((await terminal(service, job.id)).state, 'cancelled')
  assert.equal((await service.handle('fileIntegrityStart', { taskID: 7, algorithm: 'sha256' })).code, 'shuttingDown')
})
