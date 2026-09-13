import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createServer as createTCPServer } from 'node:net'
import { once } from 'node:events'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
import { validateMirrorURLs } from '../src/main/windows/engineCore.ts'
import { creationIntentDigest } from '../src/main/windows/creationReceipts.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-win-mirrors-'))
  const downloads = join(root, 'downloads'); await mkdir(downloads)
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { stateDirectory: root, defaultDownloadDirectory: downloads, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  const calls = []
  const makeEngine = () => {
    const engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} })
    engine.rpc.call = async (method, args) => { calls.push({ method, args }); return method === 'addUri' ? `gid-${calls.length}` : 'OK' }
    return engine
  }
  return { root, calls, makeEngine, engine: makeEngine(), state: async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) }
}

test('Windows commits mirrors atomically with one task and forwards a single complete addUri group', async t => {
  const f = await fixture(t)
  const input = { creationKey: randomUUID(), url: 'https://a.test/file?sig=A%2FB', mirrors: ['https://b.test/file', 'https://c.test/file'], filename: 'file.zip' }
  f.engine.rpc.call = async (method, args) => {
    f.calls.push({ method, args })
    assert.deepEqual((await f.state()).tasks[0].mirrorURLs, input.mirrors)
    assert.equal((await f.state()).creationReceipts.entries.length, 1)
    return 'first-gid'
  }
  const added = await f.engine.request('add', input)
  assert.equal(added.ok, true)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].args[0], [input.url, ...input.mirrors])
  assert.equal(f.calls[0].args[1].out, 'file.zip')
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  await f.engine.request('add', input)
  assert.equal(f.calls.length, 1, 'a creation receipt replay must not start another transfer')
})

test('Windows reload preserves mirror ordering and resume sends the same URI group', async t => {
  const f = await fixture(t)
  const input = { url: 'https://a.test/file', mirrors: ['https://b.test/file'], autoStart: false }
  const added = await f.engine.request('add', input)
  const restarted = f.makeEngine()
  await restarted.request('resume', { taskID: added.task.id })
  assert.deepEqual(f.calls.find(call => call.method === 'addUri').args[0], [input.url, ...input.mirrors])
  assert.deepEqual((await f.state()).tasks[0].mirrorURLs, input.mirrors)
})

test('Windows refuses cross-origin credentials and unsupported sources before ledger mutation', async t => {
  const f = await fixture(t)
  for (const fields of [
    { headers: ['Cookie: session=fixture'] }, { headers: ['Authorization: bearer'] },
    { headers: ['Referer: https://a.test/page'] }, { headers: ['Origin: https://a.test'] },
    { pageURL: 'https://a.test/page' }, { cookieBrowser: 'chrome' }, { url: 'https://user:password@a.test/file' },
    { mirrors: ['ftp://b.test/file'] }, { mirrors: ['https:b.test/file'] }, { mirrors: {} }
  ]) await assert.rejects(f.engine.request('add', { url: 'https://a.test/file', mirrors: ['https://b.test/file'], autoStart: false, ...fields }), /镜像/)
  assert.deepEqual((await f.engine.request('list')).tasks, [])
  assert.equal(f.calls.length, 0)
  assert.deepEqual(validateMirrorURLs('https://a.test/file', ['https://a.test/other'], { headers: ['Cookie: fixture=1'] }), ['https://a.test/other'])
})

test('resume revalidates credentials acquired after admission before any transfer RPC', async t => {
  const f = await fixture(t)
  const added = await f.engine.request('add', { url: 'https://a.test/file', mirrors: ['https://b.test/file'], autoStart: false })
  f.engine.tasks[0].headers = ['Cookie: fixture-new-session=1']
  await assert.rejects(f.engine.request('resume', { taskID: added.task.id }), /跨站镜像/)
  assert.equal(f.calls.filter(call => call.method === 'addUri').length, 0)
})

test('mirror lists and their order are bound to creation receipts; omitted and empty retain old hashes', async t => {
  const f = await fixture(t)
  const input = { url: 'https://a.test/file', mirrors: ['https://b.test/file', 'https://c.test/file'], creationKey: randomUUID(), autoStart: false }
  await f.engine.request('add', input)
  await assert.rejects(f.engine.request('add', { ...input, mirrors: [...input.mirrors].reverse() }), /请求已更改/)
  await assert.rejects(f.engine.request('add', { ...input, mirrors: ['https://d.test/file'] }), /请求已更改/)
  assert.equal((await f.engine.request('list')).tasks.length, 1)
  const plain = { url: input.url, creationKey: randomUUID(), autoStart: false }
  assert.equal(creationIntentDigest('add', plain), creationIntentDigest('add', { ...plain, mirrors: [] }))
  const original = await f.engine.request('add', plain)
  assert.equal((await f.engine.request('add', { ...plain, mirrors: [] })).task.id, original.task.id)
})

test('real standard aria2 fails over from HTTP 404 and publishes exactly one verified artifact', { skip: !process.env.NDM_ARIA2_INTEGRATION_PATH }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-aria2-mirror-live-'))
  const downloads = join(root, 'downloads')
  const payload = Buffer.from(Array.from({ length: 32768 }, (_, i) => i % 251))
  let failedRequests = 0, successRequests = 0
  const failed = createServer((_request, response) => { failedRequests++; response.writeHead(404, { 'Content-Length': 0 }); response.end() })
  const healthy = createServer((request, response) => {
    successRequests++
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1
    const body = payload.subarray(start, end + 1)
    response.writeHead(match ? 206 : 200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes', ETag: '"fixture-v1"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
    response.end(request.method === 'HEAD' ? undefined : body)
  })
  const portReservation = createTCPServer()
  let engine
  try {
    await Promise.all([new Promise(resolve => failed.listen(0, '127.0.0.1', resolve)), new Promise(resolve => healthy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve))])
    const rpcPort = portReservation.address().port
    await new Promise(resolve => portReservation.close(resolve))
    const options = { stateDirectory: root, defaultDownloadDirectory: downloads, aria2Path: process.env.NDM_ARIA2_INTEGRATION_PATH, ytDlpPath: '', ffmpegPath: '', rpcPort }
    let status
    engine = new WindowsDownloadEngine(options, { onEvent() {}, onStatus(next, error) { status = next; if (error) throw new Error(error) } })
    await engine.start()
    assert.equal(status, 'live')
    const primary = `http://127.0.0.1:${failed.address().port}/file.zip`
    const mirror = `http://127.0.0.1:${healthy.address().port}/file.zip`
    const added = await engine.request('add', { url: primary, mirrors: [mirror], filename: 'mirror-live.zip', connections: 1, creationKey: randomUUID() })
    const deadline = Date.now() + 20_000
    let task
    do {
      await new Promise(resolve => setTimeout(resolve, 100))
      task = (await engine.request('list')).tasks.find(task => task.id === added.task.id)
    } while (task.status !== 'complete' && task.status !== 'error' && Date.now() < deadline)
    assert.equal(task.status, 'complete', task.errorText)
    assert.ok(failedRequests > 0); assert.ok(successRequests > 0)
    assert.deepEqual(await readFile(join(downloads, task.filename)), payload)
    assert.equal((await engine.request('list')).tasks.length, 1)
  } finally {
    if (engine) {
      const child = engine.child
      const closed = child && child.exitCode === null ? once(child, 'close') : Promise.resolve()
      await engine.stop(); await closed
    }
    failed.closeAllConnections(); healthy.closeAllConnections()
    await Promise.all([new Promise(resolve => failed.close(resolve)), new Promise(resolve => healthy.close(resolve))])
    if (portReservation.listening) await new Promise(resolve => portReservation.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
