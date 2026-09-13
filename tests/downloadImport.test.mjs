import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOWNLOAD_IMPORT_LIMITS, parseDownloadImport } from '../src/shared/downloadImport.ts'
import { DownloadImportService, readDownloadImportFile } from '../src/main/downloadImport.ts'

const parse = parseDownloadImport
const allIssues = result => [...result.issues, ...result.entries.flatMap(entry => entry.issues)]
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function secureDependencies(overrides = {}) {
  const key = randomBytes(32)
  let stored = null
  return {
    statePath: '/unused-in-memory-fixture.enc',
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: value => {
        const iv = randomBytes(12), encryption = createCipheriv('aes-256-gcm', key, iv)
        const ciphertext = Buffer.concat([encryption.update(value, 'utf8'), encryption.final()])
        return Buffer.concat([iv, encryption.getAuthTag(), ciphertext])
      },
      decryptString: value => {
        const decryption = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
        decryption.setAuthTag(value.subarray(12, 28))
        return Buffer.concat([decryption.update(value.subarray(28)), decryption.final()]).toString('utf8')
      }
    },
    storage: { read: () => stored && Buffer.from(stored), write: bytes => { stored = Buffer.from(bytes) } },
    selectFile: async () => null,
    getCreationReceipt: async () => ({ ok: true, receipt: null }),
    createDownload: async () => ({ ok: true, task: { id: 1 } }),
    ...overrides
  }
}
function fixture(createDownload = async () => ({ ok: true, task: { id: 1 } }), overrides = {}) {
  const calls = []
  const dependencies = secureDependencies({ createDownload: async request => { calls.push(request); return createDownload(request) }, ...overrides })
  const service = new DownloadImportService(dependencies)
  return { service, calls, dependencies, preview: text => service.request('downloadImportPreview', { source: 'text', text }), create: (preview, itemIDs = preview.entries.map(entry => entry.id), autoStart = true) => service.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs, autoStart }) }
}

test('aria2 tabs preserve one task with ordered mirrors, signed URLs and options', () => {
  const text = '\uFEFF# fixture\r\nhttps://a.test/file?sig=A%2FB\thttps://a.test/mirror\r\n  out=资料.zip\r\n  dir=/tmp/downloads\r\n  header=X-Fixture: value=one\r\n  user-agent=Fixture/1\r\n  referer=https://site.test/page\r\n  pause=true\r\nhttps://c.test/next.zip\r\n'
  const result = parse(text)
  assert.deepEqual(allIssues(result), [])
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries[0].uris, ['https://a.test/file?sig=A%2FB', 'https://a.test/mirror'])
  assert.deepEqual(result.entries[0].fields, { filename: '资料.zip', folderPath: '/tmp/downloads', headers: ['X-Fixture: value=one', 'User-Agent: Fixture/1', 'Referer: https://site.test/page'], autoStart: false })
  assert.equal(result.entries[0].line, 2)
  assert.equal(result.entries[0].options[0].line, 3)
})

test('common pasted indent is normalized while orphan and malformed options retain line errors', () => {
  assert.deepEqual(allIssues(parse('  https://a.test/a\n    out=a.zip\n  https://a.test/b')), [])
  for (const [text, code, line] of [
    ['  out=orphan.zip\nhttps://a.test/a', 'orphanOption', 1],
    ['https://a.test/a\nout=forgot-indent.zip', 'missingIndent', 2],
    ['https://a.test/a\n  not-an-assignment', 'invalidOption', 2]
  ]) assert.ok(allIssues(parse(text)).some(issue => issue.code === code && issue.line === line))
})

test('unknown semantics are visible errors on the affected task rather than silently discarded', () => {
  for (const name of ['checksum', 'split', 'max-connection-per-server', 'all-proxy', 'select-file', 'seed-ratio', 'on-download-complete', '__proto__']) {
    const result = parse(`https://a.test/a\n  ${name}=value\nhttps://a.test/b`)
    assert.equal(result.entries[0].issues[0].line, 2)
    assert.equal(result.entries[1].issues.length, 0)
    assert.equal(result.entries[0].options[0]?.value ?? 'value', 'value')
  }
})

test('filenames and directory paths refuse traversal, platform reserved names and controls', () => {
  for (const name of ['../escape', '/tmp/escape', 'a\\b', 'CON.zip', 'NUL', '..', 'bad:name', 'a\u0000b', 'a?b', 'a'.repeat(256)]) {
    assert.equal(parse(`https://a.test/a\n  out=${name}`).entries[0].issues[0].code, 'invalidFilename', name)
  }
  for (const dir of ['../downloads', '~/Downloads', '/tmp/../escape', '/tmp/./escape', '/tmp/evil\u0000']) {
    assert.equal(parse(`https://a.test/a\n  dir=${dir}`).entries[0].issues[0].code, 'invalidDirectory', dir)
  }
  assert.deepEqual(allIssues(parse('https://a.test/a\n  dir=C:\\Downloads')), [])
})

test('header boundaries reject injection, engine-owned framing and duplicate names', () => {
  for (const value of ['Host: evil.test', 'Range: bytes=2-', 'Content-Length: 2', 'Accept-Encoding: gzip', 'Proxy-Authorization: secret', 'X-Test: a\rb', 'Bad Name: value', 'X:']) {
    assert.ok(parse(`https://a.test/a\n  header=${value}`).entries[0].issues.length, value)
  }
  assert.equal(parse('https://a.test/a\n  header=X-Test: one\n  header=x-test: two').entries[0].issues[0].code, 'duplicateHeader')
  assert.equal(parse('https://a.test/a\n  user-agent=one\n  header=User-Agent: two').entries[0].issues[0].code, 'duplicateHeader')
  assert.equal(parse('https://a.test/a\thttps://b.test/a\n  header=Authorization: secret').entries[0].issues[0].code, 'credentialMirrorOrigin')
  assert.deepEqual(allIssues(parse('https://a.test/a\thttps://a.test/b\n  header=Cookie: fixture=1')), [])
})

test('unsupported protocol and malformed URI normalization are rejected; Thunder retains its target', () => {
  for (const uri of ['https:example.test/file', 'https:/example.test/file', 'file:///etc/passwd', 'javascript:alert(1)', 'https://a.test/a https://b.test/b', 'https://a.test\\escape', 'sftp://a.test/file', 'magnet:?xt=urn:btih:a']) {
    assert.ok(parse(uri).entries[0].issues.some(issue => issue.code === 'unsupportedURI'), uri)
  }
  const target = 'https://a.test/a?sig=A%2FB'
  const wrapped = `thunder://${Buffer.from(`AA${target}ZZ`).toString('base64')}`
  assert.deepEqual(parse(wrapped).entries[0].uris, [target])
  assert.equal(parse('ftp://a.test/a\tftp://b.test/a').entries[0].issues[0].code, 'unsupportedMirrors')
  assert.equal(parse('ftp://a.test/a\n  header=X-Test: one').entries[0].issues[0].code, 'unsupportedHeaders')
})

test('input allocation and structural limits fail before any partial import is available', () => {
  assert.equal(parse('中'.repeat(DOWNLOAD_IMPORT_LIMITS.bytes / 2)).issues[0].code, 'tooLarge')
  assert.equal(parse('\n'.repeat(DOWNLOAD_IMPORT_LIMITS.lines)).issues[0].code, 'tooManyLines')
  assert.equal(parse('https://a.test/' + 'a'.repeat(DOWNLOAD_IMPORT_LIMITS.lineLength)).issues[0].code, 'lineTooLong')
  assert.equal(parse(Array.from({ length: 501 }, (_, i) => `https://a.test/${i}`).join('\n')).issues[0].code, 'tooManyTasks')
  assert.equal(parse(Array.from({ length: 33 }, (_, i) => `https://a.test/${i}`).join('\t')).entries[0].issues[0].code, 'tooManyMirrors')
  assert.equal(parse(' # empty\n').issues[0].code, 'empty')
})

test('preview has no side effects and creation maps mirrors into exactly one immutable request', async () => {
  const f = fixture()
  const preview = await f.preview('https://a.test/a\thttps://b.test/a\n  out=a.zip\n  pause=true')
  assert.equal(f.calls.length, 0)
  preview.entries[0].fields.filename = '../tampered'
  const result = await f.create(preview)
  assert.equal(result.results[0].status, 'accepted')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].mirrors, ['https://b.test/a'])
  assert.equal(f.calls[0].filename, 'a.zip')
  assert.equal(f.calls[0].autoStart, false)
  assert.match(f.calls[0].creationKey, /^[a-f\d-]{36}$/)
  await f.create(preview)
  assert.equal(f.calls.length, 1, 'an acknowledged task is never resent')
})

test('each row receives an ACK; a failed middle row does not erase successful neighbors', async () => {
  const receipts = new Map()
  let firstFailure = true
  const f = fixture(async request => {
    if (request.url.endsWith('/b') && firstFailure) { firstFailure = false; throw new Error('disconnected') }
    if (!receipts.has(request.creationKey)) receipts.set(request.creationKey, receipts.size + 1)
    return { ok: true, task: { id: receipts.get(request.creationKey) } }
  })
  const preview = await f.preview('https://a.test/a\nhttps://a.test/b\nhttps://a.test/c')
  const first = await f.create(preview)
  assert.deepEqual(first.results.map(row => row.status), ['accepted', 'unconfirmed', 'accepted'])
  const retry = await f.create(preview)
  assert.deepEqual(retry.results.map(row => row.status), ['accepted', 'accepted', 'accepted'])
  assert.equal(f.calls.length, 4)
  assert.equal(f.calls[1].creationKey, f.calls[3].creationKey)
  assert.equal(receipts.size, 3)
})

test('lost post-commit response reuses the creation receipt and cannot duplicate a task', async () => {
  const receipts = new Map()
  let loseReply = true
  const f = fixture(async request => {
    if (!receipts.has(request.creationKey)) receipts.set(request.creationKey, receipts.size + 1)
    if (loseReply) { loseReply = false; throw new Error('lost ACK after durable commit') }
    return { ok: true, receipt: { taskID: receipts.get(request.creationKey) } }
  })
  const preview = await f.preview('https://a.test/a')
  assert.equal((await f.create(preview)).results[0].status, 'unconfirmed')
  assert.equal((await f.create(preview, undefined, false)).results[0].taskID, 1)
  assert.deepEqual(f.calls[0], f.calls[1], 'retry preserves the first confirmed intent even if UI settings change')
  assert.equal(receipts.size, 1)
})

test('concurrent create requests for the same row share one in-flight operation', async () => {
  const gate = deferred()
  const f = fixture(async () => { await gate.promise; return { ok: true, task: { id: 4 } } })
  const preview = await f.preview('https://a.test/a')
  const one = f.create(preview)
  const two = f.create(preview)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 1)
  gate.resolve()
  assert.deepEqual(await one, await two)
})

test('an ok reply without task ID is unconfirmed and cannot be mistaken for completion', async () => {
  const f = fixture(async () => ({ ok: true }))
  const preview = await f.preview('https://a.test/a')
  assert.equal((await f.create(preview)).results[0].status, 'unconfirmed')
  await f.create(preview)
  assert.equal(f.calls[0].creationKey, f.calls[1].creationKey)
})

test('unsupported row options block that row and malformed global structure blocks all rows', async () => {
  const f = fixture()
  const rowErrors = await f.preview('https://a.test/a\n  split=4\nhttps://a.test/b')
  assert.deepEqual((await f.create(rowErrors)).results.map(row => row.status), ['failed', 'accepted'])
  assert.equal(f.calls[0].url, 'https://a.test/b')
  const structural = await f.preview('https://a.test/a\nout=missing-indent')
  await assert.rejects(f.create(structural), /结构/)
  assert.equal(f.calls.length, 1)
})

test('renderer cannot submit arbitrary paths, task IDs or a forged preview', async () => {
  let reads = 0
  const service = new DownloadImportService(secureDependencies({ selectFile: async () => null, readFile: async () => { reads++; return '' }, createDownload: async () => { throw new Error('unexpected') } }))
  assert.deepEqual(await service.request('downloadImportPreview', { source: 'file', path: '/private/ignored' }), { ok: true, cancelled: true })
  assert.equal(reads, 0)
  await assert.rejects(service.request('downloadImportCreate', { sessionID: 'forged', itemIDs: ['line-1'], autoStart: true }), /失效/)
  const f = fixture(); const preview = await f.preview('https://a.test/a')
  await assert.rejects(f.create(preview, ['line-1', 'line-1']), /请选择/)
  await assert.rejects(f.create(preview, ['unknown']), /请选择/)
  assert.equal(f.calls.length, 0)
})

test('safe file reader accepts UTF-8 and refuses oversize, invalid UTF-8, directories and FIFOs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ndm-import-test-'))
  try {
    const input = join(directory, 'tasks.txt')
    writeFileSync(input, 'https://a.test/a\n  out=中文.zip')
    assert.match(await readDownloadImportFile(input), /中文/)
    writeFileSync(input, Buffer.from([0xff, 0xfe]))
    await assert.rejects(readDownloadImportFile(input), /UTF-8/)
    writeFileSync(input, 'a'.repeat(DOWNLOAD_IMPORT_LIMITS.bytes + 1))
    await assert.rejects(readDownloadImportFile(input), /1 MiB/)
    await assert.rejects(readDownloadImportFile(directory), /普通文本|EISDIR/)
    if (process.platform !== 'win32') {
      const pipe = join(directory, 'pipe')
      execFileSync('mkfifo', [pipe])
      await assert.rejects(readDownloadImportFile(pipe), /普通文本/)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('file selection injects the bounded reader and displays the selected basename', async () => {
  const reads = []
  const service = new DownloadImportService(secureDependencies({ selectFile: async () => '/tmp/selected.txt', readFile: async (...args) => { reads.push(args); return 'https://a.test/a' }, createDownload: async () => ({ ok: true, task: { id: 1 } }) }))
  const preview = await service.request('downloadImportPreview', { source: 'file', path: '/ignored.txt' })
  assert.equal(preview.sourceName, 'selected.txt')
  assert.deepEqual(reads, [['/tmp/selected.txt', DOWNLOAD_IMPORT_LIMITS.bytes]])
})


test('encrypted file checkpoint precedes ADD and restart recovers a lost post-commit receipt without resubmitting', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ndm-import-resume-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'import.enc'), receipts = new Map(), calls = []
  const dependencies = secureDependencies({ statePath: path, storage: undefined })
  dependencies.getCreationReceipt = async key => ({ ok: true, receipt: receipts.has(key) ? { taskID: receipts.get(key), taskExists: false } : null })
  const input = 'https://user-private:password-private@a.test/a?token=query-private\n  header=Cookie: cookie-private\n  header=Authorization: Bearer auth-private'
  dependencies.createDownload = async request => {
    calls.push(request)
    const checkpoint = JSON.parse(dependencies.cipher.decryptString(readFileSync(path).subarray(Buffer.byteLength('NDM-IMPORT-1\n'))))
    assert.deepEqual(checkpoint.session.rows[0].request, request, 'complete immutable request is already on disk before ADD')
    receipts.set(request.creationKey, 31)
    throw new Error('Authorization: Bearer engine-private')
  }
  const service = new DownloadImportService(dependencies)
  const preview = await service.request('downloadImportPreview', { source: 'text', text: input })
  const first = await service.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs: ['line-1'], autoStart: false })
  assert.equal(first.results[0].status, 'unconfirmed')
  assert.ok(!JSON.stringify(first).includes('engine-private'))
  const bytes = readFileSync(path)
  for (const secret of ['password-private', 'cookie-private', 'auth-private', 'query-private', 'https://']) assert.ok(!bytes.includes(secret))
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(directory), ['import.enc'])
  const restarted = new DownloadImportService(dependencies)
  const resumed = await restarted.request('downloadImportResume')
  assert.equal(resumed.session.input, input)
  assert.equal(resumed.session.preview.sessionID, preview.sessionID)
  assert.equal(resumed.session.autoStart, false)
  assert.deepEqual(resumed.session.results, [{ id: 'line-1', status: 'accepted', taskID: 31 }])
  assert.equal(calls.length, 1, 'resume only looks up a receipt, including a receipt whose task has since been removed')
  await restarted.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs: ['line-1'], autoStart: true })
  assert.equal(calls.length, 1)
})

test('restart without receipt keeps uncertain intent; only an explicit retry reuses the exact request and key', async () => {
  const f = fixture(async () => { throw new Error('lost connection') })
  const preview = await f.preview('https://a.test/a\n  out=saved.zip')
  await f.create(preview, undefined, false)
  const restarted = new DownloadImportService(f.dependencies)
  let resumed = await restarted.request('downloadImportResume')
  assert.equal(resumed.session.results[0].status, 'unconfirmed')
  assert.equal(f.calls.length, 1)
  await assert.rejects(restarted.request('downloadImportPreview', { source: 'text', text: 'https://a.test/new' }), /未确认/)
  f.dependencies.createDownload = async request => { f.calls.push(request); return { ok: true, task: { id: 7 } } }
  await restarted.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs: ['line-1'], autoStart: true })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0], f.calls[1])
  resumed = await new DownloadImportService(f.dependencies).request('downloadImportResume')
  assert.equal(resumed.session.results[0].taskID, 7)
})

test('pending, failed and unavailable receipt lookups never resend an uncertain request', async () => {
  const f = fixture(async () => { throw new Error('lost response') })
  const preview = await f.preview('https://a.test/a')
  await f.create(preview)
  for (const lookup of [
    async () => ({ ok: true, receipt: null, pending: true }),
    async () => ({ ok: false, error: 'Cookie: engine-secret' }),
    async () => { throw new Error('Authorization: engine-secret') }
  ]) {
    f.dependencies.getCreationReceipt = lookup
    const restarted = new DownloadImportService(f.dependencies)
    assert.equal((await restarted.request('downloadImportResume')).session.results[0].status, 'unconfirmed')
    const reply = await restarted.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs: ['line-1'], autoStart: true })
    assert.equal(reply.results[0].status, 'unconfirmed')
    assert.ok(!JSON.stringify(reply).includes('engine-secret'))
  }
  assert.equal(f.calls.length, 1)
})

test('failed pre-dispatch durable write prevents ADD and preserves the previous preview and input', async () => {
  const f = fixture()
  const preview = await f.preview('https://a.test/a\n  out=original.zip')
  const bytes = f.dependencies.storage.read()
  f.dependencies.storage.write = () => { throw new Error('disk full with private pathname') }
  const result = await f.create(preview)
  assert.equal(result.results[0].status, 'failed')
  assert.match(result.results[0].error, /尚未发送/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.dependencies.storage.read(), bytes)
  await assert.rejects(f.preview('https://a.test/replacement'), /安全保存/)
  const restored = await new DownloadImportService(f.dependencies).request('downloadImportStatus')
  assert.equal(restored.session.preview.sessionID, preview.sessionID)
  assert.match(restored.session.input, /original.zip/)
  assert.deepEqual(restored.session.results, [])
})

test('post-ACK persistence failure retains uncertain checkpoint and recovers accepted status from the receipt', async () => {
  const f = fixture()
  const preview = await f.preview('https://a.test/a')
  const write = f.dependencies.storage.write
  f.dependencies.createDownload = async request => {
    f.calls.push(request)
    f.dependencies.storage.write = () => { throw new Error('disk failure') }
    return { ok: true, task: { id: 44 } }
  }
  const first = await f.create(preview)
  assert.equal(first.results[0].status, 'unconfirmed')
  f.dependencies.getCreationReceipt = async () => ({ ok: true, receipt: { taskID: 44 } })
  let resumed = await new DownloadImportService(f.dependencies).request('downloadImportResume')
  assert.equal(resumed.session.results[0].status, 'unconfirmed')
  assert.match(resumed.warning, /尚未安全保存/)
  f.dependencies.storage.write = write
  resumed = await new DownloadImportService(f.dependencies).request('downloadImportResume')
  assert.equal(resumed.session.results[0].taskID, 44)
  assert.equal(f.calls.length, 1)
})

test('encryption unavailability, basic_text, decryption failure and corrupt state retain the original bytes and never ADD', async () => {
  const f = fixture()
  await f.preview('https://a.test/a')
  const original = f.dependencies.storage.read()
  for (const cipher of [
    { ...f.dependencies.cipher, isEncryptionAvailable: () => false },
    { ...f.dependencies.cipher, getSelectedStorageBackend: () => 'basic_text' },
    { ...f.dependencies.cipher, decryptString: () => { throw new Error('keychain private detail') } }
  ]) {
    const service = new DownloadImportService({ ...f.dependencies, cipher })
    await assert.rejects(service.request('downloadImportResume'), /安全存储|解锁/)
    await assert.rejects(service.request('downloadImportPreview', { source: 'text', text: 'https://a.test/new' }))
    assert.deepEqual(f.dependencies.storage.read(), original)
  }
  f.dependencies.storage.write(Buffer.from('NDM-IMPORT-9\nfuture-state'))
  const corrupt = f.dependencies.storage.read()
  await assert.rejects(new DownloadImportService(f.dependencies).request('downloadImportResume'), /原记录已保留/)
  assert.deepEqual(f.dependencies.storage.read(), corrupt)
  assert.equal(f.calls.length, 0)
})

test('tampered encrypted request cannot acquire a fresh key or change restored intent', async () => {
  const f = fixture(async () => { throw new Error('lost ACK') })
  const preview = await f.preview('https://a.test/a')
  await f.create(preview)
  const prefix = Buffer.from('NDM-IMPORT-1\n')
  const state = JSON.parse(f.dependencies.cipher.decryptString(f.dependencies.storage.read().subarray(prefix.length)))
  state.session.rows[0].request.url = 'https://a.test/injected'
  f.dependencies.storage.write(Buffer.concat([prefix, f.dependencies.cipher.encryptString(JSON.stringify(state))]))
  const bytes = f.dependencies.storage.read()
  await assert.rejects(new DownloadImportService(f.dependencies).request('downloadImportResume'), /原记录已保留/)
  assert.deepEqual(f.dependencies.storage.read(), bytes)
  assert.equal(f.calls.length, 1)
})

test('status and resume restore an unsubmitted preview without engine writes or receipt queries', async () => {
  let lookups = 0
  const f = fixture(undefined, { getCreationReceipt: async () => { lookups++; throw new Error('unexpected') } })
  const preview = await f.preview('https://a.test/a\n  unsupported=preserve-original')
  const restarted = new DownloadImportService(f.dependencies)
  const status = await restarted.request('downloadImportStatus')
  const resumed = await restarted.request('downloadImportResume')
  assert.deepEqual(status, resumed)
  assert.equal(resumed.session.preview.sessionID, preview.sessionID)
  assert.match(resumed.session.input, /preserve-original/)
  assert.equal(resumed.session.preview.entries[0].issues[0].code, 'unsupportedOption')
  assert.equal(lookups, 0)
  assert.equal(f.calls.length, 0)
})

test('mirror preview matches engine credential and HLS boundaries before any request is creatable', () => {
  for (const header of ['Referer: https://site.test/private', 'Origin: https://site.test']) {
    assert.equal(parse(`https://a.test/file\thttps://b.test/file\n  header=${header}`).entries[0].issues[0].code, 'credentialMirrorOrigin')
    assert.deepEqual(allIssues(parse(`https://a.test/file\thttps://a.test/other\n  header=${header}`)), [])
  }
  assert.equal(parse('https://user:password@a.test/file\thttps://b.test/file').entries[0].issues[0].code, 'credentialMirrorOrigin')
  assert.equal(parse('https://a.test/file\thttps://a.test/playlist.m3u8?token=fixture').entries[0].issues[0].code, 'unsupportedMediaMirrors')
  assert.deepEqual(allIssues(parse('https://a.test/playlist.m3u8?token=fixture')), [])
})
