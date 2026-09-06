import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addFromUrl, getTasks } from '../src/renderer/src/lib/store.ts'

// Each test installs a fresh window.ndm mock: the store module is a singleton,
// so per-test spies keep classification and engine ops isolated.
function setupWindow({ classify, exportCookies, respond } = {}) {
  const ops = []
  const ndm = {
    request: async (op, params) => {
      ops.push([op, params])
      return respond(op, params)
    },
    status: async () => 'live',
    getEngineError: async () => null,
    onEvent: () => () => undefined,
    onStatus: () => () => undefined
  }
  if (classify) ndm.classifyURL = classify
  if (exportCookies) ndm.exportCookies = exportCookies
  globalThis.window = { ndm }
  return { ops, ndm }
}

function taskReply(id, url, filename) {
  return { id, filename, url, status: 'downloading', category: 'misc' }
}

function opNames(ops) {
  return ops.map(([op]) => op)
}

test('binary verdict goes straight to the download engine without probing', async () => {
  let classifyCalls = 0
  const { ops } = setupWindow({
    classify: async () => {
      classifyCalls += 1
      return { kind: 'binary', contentType: 'application/zip', disposition: null, contentLength: null }
    },
    respond: (op) => op === 'add'
      ? { task: taskReply(901, 'https://files.example.org/packages/file.zip', 'file.zip') }
      : { ok: false }
  })
  const task = await addFromUrl('https://files.example.org/packages/file.zip')
  assert.equal(classifyCalls, 1)
  assert.deepEqual(opNames(ops), ['add'])
  assert.equal(ops[0][1].headers, undefined)
  assert.equal(task.id, 901)
  assert.equal(getTasks()[0].id, 901)
})

test('a cookie-backed binary verdict attaches the session to the download', async () => {
  const { ops } = setupWindow({
    classify: async () => ({
      kind: 'binary',
      contentType: 'application/pdf',
      disposition: null,
      contentLength: 4321,
      cookieUsed: 'session=secret'
    }),
    respond: (op) => op === 'add'
      ? { task: taskReply(902, 'https://members.example.edu/theses/thesis.pdf', 'thesis.pdf') }
      : { ok: false }
  })
  await addFromUrl('https://members.example.edu/theses/thesis.pdf')
  assert.deepEqual(opNames(ops), ['add'])
  assert.deepEqual(ops[0][1].headers, ['Cookie: session=secret'])
})

test('an html verdict with formats goes through the media pipeline', async () => {
  const { ops } = setupWindow({
    classify: async () => ({ kind: 'html', contentType: 'text/html', disposition: null, contentLength: null }),
    respond: (op) => {
      if (op === 'probeMedia') {
        return {
          ok: true,
          title: '示例视频',
          duration: 42,
          formats: [{
            id: 'mp4-720',
            label: '720p',
            height: 720,
            approximateBytes: 10_000_000,
            componentBytes: [10_000_000],
            compactApproximateBytes: 8_000_000,
            compactComponentBytes: [8_000_000],
            containerHint: 'mp4',
            isVideo: true
          }],
          subtitles: []
        }
      }
      if (op === 'addMedia') {
        return { task: taskReply(903, 'https://media.example.org/watch/123', '示例视频.mp4') }
      }
      return { ok: false }
    }
  })
  const task = await addFromUrl('https://media.example.org/watch/123')
  assert.deepEqual(opNames(ops), ['probeMedia', 'addMedia'])
  const media = ops[1][1]
  assert.equal(media.url, 'https://media.example.org/watch/123')
  assert.equal(media.formatID, 'mp4-720')
  assert.equal(media.container, 'compatibleMP4')
  assert.equal(media.collectionScope, 'current')
  assert.equal(task.id, 903)
})

test('a failed media probe on a non-media site falls back to the ordinary download', async () => {
  const { ops } = setupWindow({
    classify: async () => ({ kind: 'html', contentType: 'text/html', disposition: null, contentLength: null }),
    respond: (op) => {
      if (op === 'probeMedia') throw new Error('probe engine down')
      if (op === 'add') return { task: taskReply(904, 'https://example.org/article', '') }
      return { ok: false }
    }
  })
  const task = await addFromUrl('https://example.org/article')
  assert.deepEqual(opNames(ops), ['probeMedia', 'add'])
  assert.equal(ops[1][1].headers, undefined)
  assert.equal(task.id, 904)
})

test('an unavailable classifier falls back to the filename heuristic', async () => {
  const { ops, ndm } = setupWindow({
    respond: (op) => op === 'add'
      ? { task: taskReply(905, 'https://files.example.org/archive/data.zip', 'data.zip') }
      : { ok: false }
  })
  assert.equal('classifyURL' in ndm, false)
  await addFromUrl('https://files.example.org/archive/data.zip')
  assert.deepEqual(opNames(ops), ['add'])
  assert.equal(ops[0][1].headers, undefined)
})

test('an unavailable classifier still probes plain pages before adding', async () => {
  const { ops } = setupWindow({
    respond: (op) => {
      if (op === 'probeMedia') return { ok: false }
      if (op === 'add') return { task: taskReply(906, 'https://example.org/article', '') }
      return { ok: false }
    }
  })
  await addFromUrl('https://example.org/article')
  assert.deepEqual(opNames(ops), ['probeMedia', 'add'])
})

test('proxy pointer downloads borrow the browser session the legacy way', async () => {
  const url = 'https://ezproxy.library.mcmaster.ca/login?url=https%3A%2F%2Fwww.cambridge.org%2Ffiles%2Fdownloads%2Fthing.zip'
  let exportedURL = null
  const { ops } = setupWindow({
    exportCookies: async (target) => {
      exportedURL = target
      return { ok: true, header: 'sid=token' }
    },
    respond: (op) => op === 'add' ? { task: taskReply(907, url, 'thing.zip') } : { ok: false }
  })
  await addFromUrl(url)
  assert.equal(exportedURL, url)
  assert.deepEqual(opNames(ops), ['add'])
  assert.deepEqual(ops[0][1].headers, ['Cookie: sid=token'])
})
