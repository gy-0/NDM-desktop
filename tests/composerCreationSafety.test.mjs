import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { addFromUrl, addMedia, getCreationReceipt, getTasks, replayDraftCreation } from '../src/renderer/src/lib/store.ts'

function gate() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function install(t, { classifyURL = async () => ({ kind: 'binary' }), exportCookies, respond } = {}) {
  const previous = globalThis.window
  const operations = []
  globalThis.window = { ndm: {
    classifyURL, exportCookies, status: async () => 'live',
    request: async (op, options) => {
      operations.push({ op, options: structuredClone(options) })
      return respond(op, options)
    }
  } }
  t.after(() => { globalThis.window = previous })
  return operations
}

const publicTask = (id, options) => ({ id, url: options.url, filename: options.filename || 'test.zip', status: 'paused' })
const formatsReply = { ok: true, title: 'A film', formats: [{ id: 'exact-720', label: '720p', height: 720, isVideo: true }], subtitles: [] }

test('ordinary creation waits for the durable preparation callback before emitting add', async t => {
  const entered = gate(), saved = gate()
  const input = { url: 'https://files.example.test/archive.zip?signature=a%2Fb%3D', creationKey: randomUUID(), connections: 4 }
  let prepared
  const operations = install(t, { respond: (op, options) => {
    assert.equal(op, 'add')
    return { ok: true, task: publicTask(991001, options) }
  } })
  const creating = addFromUrl(input, async (op, options) => {
    prepared = { op, options: structuredClone(options) }
    entered.resolve()
    await saved.promise
  })
  await entered.promise
  assert.deepEqual(operations, [])
  assert.deepEqual(prepared, { op: 'add', options: input })
  saved.resolve()
  const task = await creating
  assert.equal(task.id, 991001)
  assert.deepEqual(operations, [prepared])
})

test('failed ordinary draft persistence prevents every creation RPC', async t => {
  const operations = install(t, { respond: () => assert.fail('save failure must prevent creation') })
  await assert.rejects(addFromUrl({ url: 'https://files.example.test/archive.zip', creationKey: randomUUID() }, async () => {
    throw new Error('draft write failed')
  }), /draft write failed/)
  assert.deepEqual(operations, [])
})

test('direct media creation waits for preparation and preserves its rejection without sending addMedia', async t => {
  const entered = gate(), release = gate()
  const operations = install(t, { respond: () => assert.fail('preparation never committed') })
  const input = { url: 'https://media.example.test/watch', creationKey: randomUUID(), formatID: 'exact-720', collectionScope: 'current' }
  const creating = addMedia(input, async (op, options) => {
    assert.equal(op, 'addMedia')
    assert.deepEqual(options, input)
    entered.resolve()
    await release.promise
    throw new Error('secure storage unavailable')
  })
  const rejected = assert.rejects(creating, /secure storage unavailable/)
  await entered.promise
  assert.deepEqual(operations, [])
  release.resolve()
  await rejected
  assert.deepEqual(operations, [])
})

test('media preparation failure cannot fall back to ordinary add on a generic website', async t => {
  const operations = install(t, {
    classifyURL: async () => ({ kind: 'html' }),
    respond: op => { assert.equal(op, 'probeMedia'); return formatsReply }
  })
  let preparations = 0
  await assert.rejects(addFromUrl({ url: 'https://media.example.test/watch/123', creationKey: randomUUID(), connections: 6 }, async (op, options) => {
    preparations++
    assert.equal(op, 'addMedia')
    assert.equal(options.connections, 6)
    assert.equal(options.formatID, 'exact-720')
    throw new Error('draft save rejected')
  }), /draft save rejected/)
  assert.equal(preparations, 1)
  assert.deepEqual(operations.map(item => item.op), ['probeMedia'])
})

test('a lost media creation reply cannot trigger a second ordinary download', async t => {
  let created = 0
  const creationKey = randomUUID()
  const operations = install(t, {
    classifyURL: async () => ({ kind: 'html' }),
    respond: (op, options) => {
      if (op === 'probeMedia') return formatsReply
      if (op === 'addMedia') {
        assert.equal(options.creationKey, creationKey)
        created++
        throw new Error('connection closed after commit')
      }
      if (op === 'getCreationReceipt') return { ok: true, receipt: { taskID: 991002, taskExists: true } }
      assert.fail('A creation failure must never fall back to add')
    }
  })
  let prepared
  await assert.rejects(addFromUrl({ url: 'https://media.example.test/watch/123', creationKey }, async (op, options) => {
    prepared = { op, options: structuredClone(options) }
  }), /connection closed after commit/)
  assert.equal(created, 1)
  assert.equal(prepared.op, 'addMedia')
  assert.equal(prepared.options.creationKey, creationKey)
  assert.deepEqual(operations.map(item => item.op), ['probeMedia', 'addMedia'])
  assert.equal((await getCreationReceipt(creationKey)).taskID, 991002)
  assert.equal(created, 1)
})

test('a media creation error reply is not mistaken for a failed probe', async t => {
  const operations = install(t, {
    classifyURL: async () => ({ kind: 'html' }),
    respond: op => op === 'probeMedia' ? formatsReply : { ok: false, error: 'start failed' }
  })
  await assert.rejects(addFromUrl({ url: 'https://media.example.test/watch', creationKey: randomUUID() }, async () => undefined), /添加媒体任务失败/)
  assert.deepEqual(operations.map(item => item.op), ['probeMedia', 'addMedia'])
})

test('a known video page without a format never prepares or sends a creation', async t => {
  const operations = install(t, {
    classifyURL: async () => ({ kind: 'html' }),
    respond: op => { assert.equal(op, 'probeMedia'); return { ok: true, formats: [] } }
  })
  await assert.rejects(addFromUrl({ url: 'https://vimeo.com/123456', creationKey: randomUUID() }, async () => assert.fail('no reviewed media request exists')))
  assert.deepEqual(operations.map(item => item.op), ['probeMedia'])
})

test('prepared file replay preserves exact intent and refreshes only the browser session', async t => {
  const request = Object.freeze({ op: 'add', options: Object.freeze({
    url: 'https://files.example.test/data.zip?signature=a%2Fb%3D&part=1',
    creationKey: randomUUID(), folderPath: '/Synthetic/Chosen Folder', filename: 'Archive 资料.zip',
    connections: 4, autoStart: false, cookieBrowser: 'chrome'
  }) })
  const exports = []
  const operations = install(t, {
    classifyURL: async () => assert.fail('replay must not classify again'),
    exportCookies: async (url, browser) => { exports.push({ url, browser }); return { ok: true, header: 'session=synthetic-new' } },
    respond: (op, options) => { assert.equal(op, 'add'); return { ok: true, task: publicTask(991003, options) } }
  })
  const task = await replayDraftCreation(request)
  assert.equal(task.id, 991003)
  assert.deepEqual(exports, [{ url: request.options.url, browser: 'chrome' }])
  assert.deepEqual(operations, [{ op: 'add', options: { ...request.options, headers: ['Cookie: session=synthetic-new'] } }])
  assert.equal(Object.hasOwn(request.options, 'headers'), false)
})

test('prepared media replay uses the reviewed format and avoids classification, probing and changed defaults', async t => {
  const request = { op: 'addMedia', options: {
    url: 'https://media.example.test/watch/456', creationKey: randomUUID(), formatID: 'original-137+140',
    container: 'compactMKV', subtitleLanguage: 'zh-Hans', collectionScope: 'current', connections: 5,
    folderPath: '/Synthetic/Reviewed Folder', filename: 'Reviewed film.mkv', cookieBrowser: 'chrome'
  } }
  const operations = install(t, {
    classifyURL: async () => assert.fail('replay cannot classify'),
    exportCookies: async () => assert.fail('media engine owns its browser session'),
    respond: (op, options) => { assert.equal(op, 'addMedia'); return { ok: true, task: publicTask(991004, options) } }
  })
  await replayDraftCreation(request)
  await replayDraftCreation(request)
  assert.deepEqual(operations, [request, request])
  assert.equal(getTasks().filter(task => task.id === 991004).length, 1)
})

test('cookie refresh failure does not rewrite a prepared request or launch alternate classification', async t => {
  const request = { op: 'add', options: { url: 'https://files.example.test/private.zip', creationKey: randomUUID(), cookieBrowser: 'chrome' } }
  const operations = install(t, {
    classifyURL: async () => assert.fail('replay cannot fall back to classification'),
    exportCookies: async () => { throw new Error('browser locked') },
    respond: (op, options) => { assert.equal(op, 'add'); return { ok: true, task: publicTask(991005, options) } }
  })
  await replayDraftCreation(request)
  assert.deepEqual(operations, [request])
})

test('receipt reconciliation distinguishes absent, pending, accepted and deleted without creating downloads', async t => {
  const key = randomUUID()
  const replies = [
    { ok: true, receipt: null },
    { ok: true, receipt: null, pending: true },
    { ok: true, pending: true },
    { ok: true, receipt: { taskID: 991006, taskExists: true }, task: publicTask(991006, { url: 'https://files.example.test/accepted.zip' }) },
    { ok: true, receipt: { taskID: 991007, taskExists: false } }
  ]
  const operations = install(t, { respond: op => { assert.equal(op, 'getCreationReceipt'); return replies.shift() } })
  assert.deepEqual(await getCreationReceipt(key), { pending: false, taskID: undefined, task: undefined })
  assert.equal((await getCreationReceipt(key)).pending, true)
  assert.equal((await getCreationReceipt(key)).pending, true)
  const accepted = await getCreationReceipt(key)
  assert.equal(accepted.taskID, 991006)
  assert.equal(accepted.task.id, 991006)
  const deleted = await getCreationReceipt(key)
  assert.equal(deleted.taskID, 991007)
  assert.equal(deleted.task, undefined)
  assert.equal(deleted.pending, false)
  assert.equal(operations.length, 5)
})

test('a tombstone reply to a replay stays unresolved for reconciliation and never falls back to add', async t => {
  const request = { op: 'addMedia', options: { url: 'https://media.example.test/watch', creationKey: randomUUID(), formatID: 'exact-720' } }
  const operations = install(t, { respond: () => ({ ok: true, receipt: { taskID: 991008, taskExists: false } }) })
  await assert.rejects(replayDraftCreation(request), /尚未确认添加结果/)
  assert.equal((await getCreationReceipt(request.options.creationKey)).taskID, 991008)
  assert.deepEqual(operations.map(item => item.op), ['addMedia', 'getCreationReceipt'])
})

test('missing or unsupported receipt replies cannot authorize retry as if creation were absent', async t => {
  const replies = [undefined, { ok: false, error: 'unknown operation' }, { ok: true }, { ok: true, pending: false }]
  install(t, { respond: () => replies.shift() })
  for (let i = 0; i < 4; i++) await assert.rejects(getCreationReceipt(randomUUID()), /暂时无法确认/)
})

test('malformed receipt identities are rejected instead of turning an uncertain creation into an absent result', async t => {
  const replies = [
    { ok: true, receipt: {} }, { ok: true, receipt: undefined },
    { ok: true, receipt: { taskID: 0, taskExists: true } },
    { ok: true, receipt: { taskID: '991009', taskExists: true } },
    { ok: true, receipt: { taskID: 991009 } },
    { ok: true, receipt: { taskID: 991009, taskExists: true }, task: { id: 991010 } }
  ]
  install(t, { respond: () => replies.shift() })
  for (let i = 0; i < 6; i++) await assert.rejects(getCreationReceipt(randomUUID()), /暂时无法确认/)
})
