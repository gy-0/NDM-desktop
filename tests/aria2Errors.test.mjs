import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatAria2Error, sanitizeDownloadError } from '../src/main/windows/aria2Errors.ts'
import { Aria2Rpc } from '../src/main/windows/aria2Rpc.ts'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-aria2-errors-'))
  const events = []
  const engine = new WindowsDownloadEngine({
    stateDirectory: root,
    defaultDownloadDirectory: join(root, 'downloads'),
    aria2Path: '', ytDlpPath: '', ffmpegPath: ''
  }, { onEvent: (event) => events.push(event), onStatus() {} })
  // All tests use a fake RPC transport and never start a process or listener.
  engine.rpc.call = async (method) => assert.fail(`Unexpected RPC: ${method}`)
  t.after(async () => {
    await engine.saveChain
    await rm(root, { recursive: true, force: true })
  })
  return { root, events, engine, statePath: join(root, 'state.json') }
}

test('aria2 failures distinguish disk, resume, duplicate, authentication and integrity recovery', () => {
  for (const [code, reason, action] of [
    ['2', '超时', '网络'],
    ['8', '断点', '重新下载'],
    ['9', '空间不足', '释放磁盘空间'],
    ['11', '同一文件', '现有任务'],
    ['12', '同一种子', '现有任务'],
    ['13', '文件已存在', '保留已有文件'],
    ['19', '解析服务器地址', 'DNS'],
    ['24', '身份验证失败', '重新登录'],
    ['32', '校验失败', '重新下载']
  ]) {
    const message = formatAria2Error(code, 'engine detail with Cookie: secret')
    assert.ok(message.includes(reason), `${code} explains the cause`)
    assert.ok(message.includes(action), `${code} suggests a recovery action`)
    assert.ok(!message.includes('secret'))
  }
})

test('unknown aria2 failures retain useful details and codes without URL credentials or headers', () => {
  const raw = [
    'TLS negotiation failed at https://test-user:test-password@cdn.example.test/file.zip?download=private-query#private-fragment',
    'Cookie: sid=private-cookie; other=private-cookie-two',
    'Authorization: Bearer private-auth',
    'Proxy-Authorization: Basic cHJpdmF0ZS1wcm94eQ==',
    'Retry route ftp://ftp-user:ftp-password@mirror.example.test:21/file.zip?key=ftp-query',
    'Malformed URL https://bad-user:bad-password@host:bad/file?key=malformed-query',
    'Underlying cause: certificate issuer unavailable'
  ].join('\n')
  const message = formatAria2Error('999', raw)
  assert.match(message, /错误码 999/)
  assert.match(message, /TLS negotiation failed/)
  assert.match(message, /certificate issuer unavailable/)
  assert.match(message, /https:\/\/cdn\.example\.test\/file\.zip\?\[已隐藏\]/)
  assert.match(message, /ftp:\/\/mirror\.example\.test:21\/file\.zip/)
  for (const secret of [
    'test-user', 'test-password', 'private-query', 'private-fragment', 'private-cookie',
    'private-auth', 'cHJpdmF0ZS1wcm94eQ==', 'ftp-user', 'ftp-password', 'ftp-query',
    'bad-user', 'bad-password', 'malformed-query'
  ]) assert.ok(!message.includes(secret), `${secret} is redacted`)
  assert.equal(sanitizeDownloadError(message), message, 'publicTask may sanitize an already formatted error')
})

test('header redaction handles serialized values, folded lines and control characters before truncation', () => {
  const raw = [
    'Request {"aUtHoRiZaTiOn": "Bearer serialized-secret", "Cookie": "session=serialized-cookie"}',
    'Set-Cookie: folded-cookie',
    '  continued-cookie',
    'Auth\u0000orization=Basic standalone-secret',
    'Proxy response: Bearer bare-token',
    'Useful failure: invalid response'
  ].join('\n')
  const message = sanitizeDownloadError(raw)
  for (const secret of ['serialized-secret', 'serialized-cookie', 'folded-cookie', 'continued-cookie', 'standalone-secret', 'bare-token']) {
    assert.ok(!message.includes(secret), secret)
  }
  assert.match(message, /Useful failure: invalid response/)
  assert.equal(sanitizeDownloadError(undefined), undefined)
  assert.equal(sanitizeDownloadError('\u0000  '), undefined)
  assert.ok(sanitizeDownloadError(`Cookie: ${'secret'.repeat(1000)}`).length < 40)
  assert.ok(sanitizeDownloadError('x'.repeat(5000)).length <= 2001)
})

test('generic and absent error codes preserve safe engine explanations without treating them as known causes', () => {
  assert.match(formatAria2Error('1', 'custom failure'), /未知错误[\s\S]*custom failure/)
  assert.match(formatAria2Error(undefined, 'custom failure'), /custom failure/)
  assert.match(formatAria2Error('900', undefined), /错误码 900/)
  assert.equal(formatAria2Error(undefined, '\u0000'), 'aria2 下载失败。请稍后重试。')
  assert.ok(!formatAria2Error('private-code', '').includes('private-code'))
})

test('engine polling publishes mapped and redacted failures, persists safe details, and preserves removal behavior', async (t) => {
  const f = await fixture(t)
  let sequence = 0
  const statuses = new Map()
  f.engine.rpc.call = async (method, args) => {
    if (method === 'addUri') return `fake-gid-${++sequence}`
    assert.equal(method, 'tellStatus')
    assert.ok(statuses.has(args[0]))
    return { gid: args[0], totalLength: '100', completedLength: '20', downloadSpeed: '999', ...statuses.get(args[0]) }
  }
  const disk = await f.engine.request('add', { url: 'https://example.test/disk.zip' })
  const unknown = await f.engine.request('add', { url: 'https://example.test/unknown.zip' })
  const removed = await f.engine.request('add', { url: 'https://example.test/removed.zip' })
  statuses.set('fake-gid-1', { status: 'error', errorCode: '9', errorMessage: 'write failed' })
  statuses.set('fake-gid-2', {
    status: 'error', errorCode: '777',
    errorMessage: 'Custom transport failure https://user:pass@cdn.example.test/file?key=secret-query\nCookie: snapshot-cookie'
  })
  statuses.set('fake-gid-3', { status: 'removed', errorCode: '9', errorMessage: 'Download removed by engine' })

  await f.engine.poll()
  const listed = (await f.engine.request('list')).tasks
  assert.match(listed.find((task) => task.id === disk.task.id).errorText, /空间不足.*释放磁盘空间/)
  const unknownTask = listed.find((task) => task.id === unknown.task.id)
  assert.equal(unknownTask.status, 'error')
  assert.equal(unknownTask.bytesPerSecond, 0)
  assert.match(unknownTask.errorText, /错误码 777[\s\S]*Custom transport failure/)
  assert.match(unknownTask.errorText, /cdn\.example\.test\/file/)
  assert.ok(!unknownTask.errorText.includes('secret-query'))
  assert.ok(!unknownTask.errorText.includes('snapshot-cookie'))
  assert.ok(!unknownTask.errorText.includes('user:pass'))
  const removedTask = listed.find((task) => task.id === removed.task.id)
  assert.equal(removedTask.status, 'error', 'do not change the pre-existing removed-state lifecycle')
  assert.equal(removedTask.errorText, 'Download removed by engine', 'removal does not acquire the disk-full diagnosis')
  assert.deepEqual(f.events.at(-1), { op: 'snapshot', tasks: listed })
  const persisted = JSON.parse(await readFile(f.statePath, 'utf8')).tasks
  assert.equal(persisted.find((task) => task.id === unknown.task.id).errorText, unknownTask.errorText)
})

test('a transient RPC fault does not mark an otherwise active download as failed', async (t) => {
  const f = await fixture(t)
  f.engine.rpc.call = async (method) => {
    if (method === 'addUri') return 'live-gid'
    assert.equal(method, 'tellStatus')
    throw new Error('temporary RPC outage')
  }
  await f.engine.request('add', { url: 'https://example.test/live.zip' })
  await f.engine.poll()
  const task = (await f.engine.request('list')).tasks[0]
  assert.equal(task.status, 'downloading')
  assert.equal(task.errorText, undefined)
})

test('restored legacy history redacts error details through the public list without changing status or source URL', async (t) => {
  const f = await fixture(t)
  const originalURL = 'https://example.test/original.zip'
  const history = {
    nextId: 2,
    tasks: [{
      id: 1, url: originalURL, filename: 'original.zip', title: 'original.zip', source: 'example.test',
      category: 'compressed', status: 'error', folderPath: join(f.root, 'downloads'), fileSize: 100,
      completedBytes: 10, bytesPerSecond: 0, connections: 4, bandwidthLimit: 0,
      errorText: 'Legacy failure at https://legacy-user:legacy-password@cdn.example.test/a?signature=legacy-query\nAuthorization: Bearer legacy-token'
    }]
  }
  await writeFile(f.statePath, JSON.stringify(history))
  const task = (await f.engine.request('list')).tasks[0]
  assert.equal(task.status, 'error')
  assert.equal(task.url, originalURL)
  assert.match(task.errorText, /Legacy failure at https:\/\/cdn\.example\.test\/a/)
  for (const secret of ['legacy-user', 'legacy-password', 'legacy-query', 'legacy-token']) assert.ok(!task.errorText.includes(secret))
})

test('JSON-RPC envelope errors are redacted without misusing the download error-code map', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    id: 1, jsonrpc: '2.0', error: {
      code: 9,
      message: 'RPC rejected custom request https://rpc-user:rpc-pass@example.test/path?token=rpc-query\nAuthorization: Bearer rpc-secret'
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const rpc = new Aria2Rpc('http://127.0.0.1:1/jsonrpc', 'fake-test-secret')
  await assert.rejects(rpc.call('addUri', [['https://example.test/file']]), (error) => {
    assert.match(error.message, /RPC rejected custom request/)
    assert.ok(!error.message.includes('空间不足'))
    for (const secret of ['rpc-user', 'rpc-pass', 'rpc-query', 'rpc-secret']) assert.ok(!error.message.includes(secret))
    return true
  })
})
