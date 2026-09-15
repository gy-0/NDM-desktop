import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrowserStateFile, BrowserStateReadError } from '../src/main/browserStateFile.ts'

const privatePath = '/synthetic/private-profile-route/Local State'
const privateValue = 'synthetic-secret-token'
const state = { profile: { last_active_profiles: ['Profile 2'], info_cache: { 'Profile 2': { name: '合成资料' } } } }
const bytes = Buffer.from(JSON.stringify(state))
const maximumBytes = 8 * 1024 * 1024

function file(options = {}) {
  const data = options.data ?? bytes
  const size = options.size ?? data.length
  const result = { reads: [], stats: 0, closes: 0 }
  result.handle = {
    async stat() {
      result.stats++
      if (options.statError) throw options.statError
      return { size: result.stats > 1 ? options.afterSize ?? size : size,
        mtimeMs: options.changed && result.stats > 1 ? 2 : 1, isFile: () => options.regular !== false }
    },
    async read(buffer, offset, length, position) {
      assert.ok(buffer.length <= maximumBytes + 1, 'A read must not allocate beyond the bounded file plus one growth sentinel')
      result.reads.push({ offset, length, position })
      if (options.readError) throw options.readError
      const count = Math.min(length, options.chunk ?? length, Math.max(0, data.length - position))
      data.copy(buffer, offset, position, position + count)
      return { bytesRead: count }
    },
    async close() { result.closes++ }
  }
  return result
}
function reader(files) {
  const calls = [], opened = []
  let pauses = 0
  return {
    calls, opened, get pauses() { return pauses },
    dependencies: {
      async openFile(path) {
        calls.push(path)
        const item = files[calls.length - 1]
        assert.ok(item, 'No unbounded retries or fallback file opens')
        if (item instanceof Error) throw item
        opened.push(item)
        return item.handle
      },
      async pause() {
        pauses++
        assert.ok(opened.every(item => item.closes === 1), 'Close each attempt before retry backoff')
      }
    }
  }
}
function rejection(cause, stage) {
  return error => {
    assert.ok(error instanceof BrowserStateReadError)
    assert.equal(error.cause, cause)
    assert.equal(error.stage, stage)
    assert.equal(typeof error.cause, 'string')
    const exposed = [String(error), error.stack, JSON.stringify(error)].join('\n')
    assert.ok(!exposed.includes(privatePath), 'Errors must not expose the requested path')
    assert.ok(!exposed.includes(privateValue), 'Errors must not expose malformed file contents')
    return true
  }
}

test('browser Local State short reads concatenate all bytes including split UTF-8 before parsing', async () => {
  const entry = file({ chunk: 2 }), fixture = reader([entry])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.equal(fixture.calls.length, 1)
  assert.ok(entry.reads.length > 2)
  assert.deepEqual(entry.reads.slice(0, 3).map(read => read.position), [0, 2, 4])
  assert.equal(entry.closes, 1)
  assert.equal(fixture.pauses, 0)
})

test('browser Local State retries a changed file through a fresh handle and returns only the stable snapshot', async () => {
  const changed = file({ changed: true }), recovered = file(), fixture = reader([changed, recovered])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.deepEqual(fixture.calls, [privatePath, privatePath])
  assert.deepEqual([changed.closes, recovered.closes], [1, 1])
  assert.equal(fixture.pauses, 1)
})

test('browser Local State continuously changing metadata fails after three closed attempts', async () => {
  const entries = Array.from({ length: 3 }, () => file({ changed: true })), fixture = reader(entries)
  await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection('changed', 'read'))
  assert.equal(fixture.calls.length, 3)
  assert.equal(fixture.pauses, 2)
  assert.ok(entries.every(entry => entry.closes === 1))
})

test('browser Local State changed final stat size rejects even a complete JSON buffer with unchanged timestamp', async () => {
  const changed = file({ afterSize: bytes.length + 1 }), recovered = file(), fixture = reader([changed, recovered])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.equal(fixture.calls.length, 2)
  assert.deepEqual([changed.closes, recovered.closes], [1, 1])
})

test('browser Local State detects growth beyond the initial size instead of accepting a valid JSON prefix', async () => {
  const grew = file({ data: Buffer.from('{} '), size: 2 }), recovered = file(), fixture = reader([grew, recovered])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.equal(fixture.calls.length, 2)
  assert.deepEqual([grew.closes, recovered.closes], [1, 1])
})

test('browser Local State early EOF retries a new handle rather than parsing a partial snapshot', async () => {
  const shortened = file({ data: Buffer.from('{}'), size: bytes.length }), recovered = file(), fixture = reader([shortened, recovered])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.equal(fixture.calls.length, 2)
  assert.deepEqual([shortened.closes, recovered.closes], [1, 1])
})

test('browser Local State malformed JSON retries at most three times and does not expose parser input', async () => {
  const entries = Array.from({ length: 3 }, () => file({ data: Buffer.from(`{"private":"${privateValue}",`) })), fixture = reader(entries)
  await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection('malformed', 'parse'))
  assert.equal(fixture.calls.length, 3)
  assert.equal(fixture.pauses, 2)
  assert.ok(entries.every(entry => entry.closes === 1))
})

test('browser Local State malformed in-progress JSON can recover on its next open', async () => {
  const first = file({ data: Buffer.from('{') }), second = file(), fixture = reader([first, second])
  assert.deepEqual(await readBrowserStateFile(privatePath, fixture.dependencies), state)
  assert.equal(fixture.calls.length, 2)
  assert.deepEqual([first.closes, second.closes], [1, 1])
})

for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
  test(`browser Local State ${code} is preserved without retries, path leaks or Default fallback`, async () => {
    const error = Object.assign(new Error(`${code}: ${privatePath}`), { code })
    const fixture = reader([error])
    await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection(code, 'open'))
    assert.deepEqual(fixture.calls, [privatePath])
    assert.equal(fixture.pauses, 0)
    assert.equal(fixture.opened.length, 0)
  })
}

for (const stage of ['statError', 'readError']) {
  test(`browser Local State permission failure during ${stage} still closes the handle without fallback`, async () => {
    const error = Object.assign(new Error(`EACCES: ${privatePath}`), { code: 'EACCES' })
    const entry = file({ [stage]: error }), fixture = reader([entry])
    await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection('EACCES', stage === 'statError' ? 'stat' : 'read'))
    assert.equal(fixture.calls.length, 1)
    assert.equal(entry.closes, 1)
    assert.equal(fixture.pauses, 0)
  })
}

test('browser Local State disappearing between retries preserves ENOENT and closes the earlier snapshot', async () => {
  const changed = file({ changed: true }), missing = Object.assign(new Error(privatePath), { code: 'ENOENT' })
  const fixture = reader([changed, missing])
  await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection('ENOENT', 'open'))
  assert.equal(fixture.calls.length, 2)
  assert.equal(changed.closes, 1)
  assert.equal(fixture.pauses, 1)
})

for (const [name, options, cause] of [['oversize', { size: maximumBytes + 1 }, 'tooLarge'], ['non-regular', { regular: false }, 'notRegular']]) {
  test(`browser Local State ${name} files are rejected before reading and the handle is closed`, async () => {
    const entry = file(options), fixture = reader([entry])
    await assert.rejects(readBrowserStateFile(privatePath, fixture.dependencies), rejection(cause, 'stat'))
    assert.equal(fixture.calls.length, 1)
    assert.equal(entry.reads.length, 0)
    assert.equal(entry.closes, 1)
    assert.equal(fixture.pauses, 0)
  })
}

test('browser Local State reads a real synthetic temporary file through the default filesystem dependency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-browser-state-file-'))
  try {
    const path = join(directory, 'Local State')
    await writeFile(path, JSON.stringify(state))
    assert.deepEqual(await readBrowserStateFile(path), state)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
