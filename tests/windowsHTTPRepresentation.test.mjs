import assert from 'node:assert/strict'
import test from 'node:test'
import { representationFromProbe, assertSameHTTPRepresentation, representationHeaders, probeHTTPRepresentation, readHTTPRepresentation } from '../src/main/windows/httpRepresentation.ts'
const reply = (etag = '"v1"', url = 'https://example.test/file', total = 8192) => ({ status: 206, url, headers: { ETag: etag, 'Content-Range': `bytes 0-0/${total}` } })
test('same-size replacement and changed effective URL cannot reuse saved bytes', () => {
  const original = representationFromProbe(reply())
  assert.deepEqual(assertSameHTTPRepresentation(original, representationFromProbe(reply())), original)
  for (const changed of [reply('"v2"'), reply('"v1"', 'https://other.test/file'), reply('"v1"', undefined, 9000)]) {
    assert.throws(() => assertSameHTTPRepresentation(original, representationFromProbe(changed)))
  }
  assert.deepEqual(representationHeaders(original), { 'If-Range': '"v1"', 'If-Match': '"v1"', 'Accept-Encoding': 'identity' })
})
test('weak, missing, malformed, duplicate validators and stale ledgers fail closed', () => {
  for (const etag of ['W/"v1"', undefined, 'v1', '"v1"\r\nHeader: bad', ['"a"', '"b"']]) {
    assert.equal(representationFromProbe(reply(etag === undefined ? '' : etag)), undefined)
  }
  assert.equal(readHTTPRepresentation({ version: 1, resourceHash: 'a'.repeat(64), etag: '"x"', totalBytes: -1 }), undefined)
  assert.throws(() => assertSameHTTPRepresentation(undefined, representationFromProbe(reply())))
  assert.throws(() => representationFromProbe({ ...reply(), headers: { ETag: '"x"', 'Content-Range': 'bytes 10-11/8192' } }))
})
test('redirect probing removes all unrecognized cross-origin headers and aborts unsafe hops', async () => {
  const requests = []
  const found = await probeHTTPRepresentation('https://example.test/file', ['Authorization: secret', 'X-Custom-Token: secret', 'User-Agent: NDM'], async request => {
    requests.push(request)
    return requests.length === 1 ? { status: 302, url: request.url, headers: { location: 'https://cdn.test/file' } } : reply('"v1"', request.url)
  })
  assert.ok(found)
  assert.deepEqual(requests[1].headers, { 'user-agent': 'NDM', range: 'bytes=0-0', 'accept-encoding': 'identity' })
  await assert.rejects(probeHTTPRepresentation('https://example.test/file', [], async request => ({ status: 302, url: request.url, headers: { location: 'http://example.test/file' } })))
})

test('identity is durable before admission and a failed identity write cannot be skipped on retry', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { WindowsDownloadEngine } = await import('../src/main/windows/windowsEngine.ts')
  const root = await mkdtemp(join(tmpdir(), 'ndm-identity-ledger-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const identity = representationFromProbe(reply())
  const engine = new WindowsDownloadEngine({ stateDirectory: root, defaultDownloadDirectory: root, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }, { onEvent() {}, onStatus() {}, inspectHTTPRepresentation: async () => identity })
  t.after(() => engine.responseGuard?.close())
  const created = await engine.request('add', { url: reply().url, filename: 'fixture.bin', autoStart: false })
  const write = engine.writeState.bind(engine)
  let fail = true, admissions = 0
  engine.writeState = async payload => { if (fail) throw new Error('ENOSPC'); await write(payload) }
  engine.rpc.call = async (method, args) => {
    assert.equal(method, 'addUri')
    admissions++
    const disk = JSON.parse(await readFile(join(root,'state.json'),'utf8'))
    assert.deepEqual(disk.tasks[0].httpRepresentation, identity)
    assert.match(args[0][0], /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/)
    assert.equal(args[1].header, undefined, 'upstream credentials belong to the response guard')
    assert.equal(args[1]['no-proxy'], '127.0.0.1')
    assert.equal(args[1]['all-proxy'], '')
    assert.equal(args[1]['always-resume'], 'true')
    return 'fixture-gid'
  }
  await assert.rejects(engine.request('resume', {taskID: created.task.id}), /ENOSPC/)
  assert.equal(admissions, 0)
  assert.equal(engine.tasks[0].httpRepresentation, undefined)
  fail = false
  await engine.request('resume', {taskID: created.task.id})
  assert.equal(admissions, 1)
})

test('legacy unowned mirrors cannot bypass a pinned response guard', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { WindowsDownloadEngine } = await import('../src/main/windows/windowsEngine.ts')
  const root = await mkdtemp(join(tmpdir(), 'ndm-guard-mirror-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const engine = new WindowsDownloadEngine({ stateDirectory: root, defaultDownloadDirectory: root, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }, { onEvent() {}, onStatus() {}, inspectHTTPRepresentation: async () => representationFromProbe(reply()) })
  const created = await engine.request('add', { url: reply().url, mirrors: ['https://mirror.test/file'], autoStart: false })
  delete engine.tasks[0].mirrorAttempt
  engine.rpc.call = async () => { throw new Error('unguarded mirror was admitted') }
  await assert.rejects(engine.request('resume', { taskID: created.task.id }), /缺少独立来源记录/)
})
