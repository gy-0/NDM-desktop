import assert from 'node:assert/strict'
import test from 'node:test'
import { browserMediaSessionFromEvent, mediaSessionURL } from '../src/renderer/src/lib/browserMediaSession.ts'
import { addFromUrl, probeMedia, replayDraftCreation, checkStorage } from '../src/renderer/src/lib/store.ts'
import { draftCreationRequest } from '../src/renderer/src/lib/composerBatch.ts'

const url = 'https://video.example.test/watch?id=1'
const id = '14327316-f4a3-4314-9931-23b48c43e4ef'

test('handoff identity is explicit and scoped to a normalized web URL', () => {
  assert.deepEqual(browserMediaSessionFromEvent({ url: `${url}#player`, browserSessionID: id, browserSessionBrowser: 'chrome' }), { id, url, browser: 'chrome' })
  for (const bad of ['', 'short', 'session token has spaces']) assert.equal(browserMediaSessionFromEvent({ url, browserSessionID: bad }), null)
  assert.equal(browserMediaSessionFromEvent({ url }), null)
  assert.equal(mediaSessionURL('https://user:secret@video.example.test/watch'), null)
  assert.equal(mediaSessionURL('file:///tmp/video.mp4'), null)
  assert.notEqual(mediaSessionURL(url), mediaSessionURL(`${url}2`))
})

test('Relay media operations keep their explicit source and never classify through a default browser', async () => {
  const calls = []
  globalThis.window = { ndm: {
    classifyURL: async () => { throw new Error('Relay handoffs must not classify through another profile') },
    request: async (op, options) => {
      calls.push({ op, options })
      return op === 'probeMedia' ? { ok: true, formats: [{ id: '720p' }] } : { ok: true, task: { id: 88001, url, filename: 'video.mp4' } }
    }
  } }
  await addFromUrl({ url, browserSessionID: id, browserSessionBrowser: 'chrome' })
  assert.deepEqual(calls.map(call => call.op), ['probeMedia', 'addMedia'])
  for (const call of calls) {
    assert.equal(call.options.browserSessionID, id)
    assert.equal(call.options.browserSessionBrowser, 'chrome')
    assert.equal(call.options.cookieBrowser, 'chrome')
  }
})

test('a failed Relay video probe cannot create an ordinary HTML task on an unfamiliar site', async () => {
  const calls = []
  globalThis.window = { ndm: { request: async (op) => { calls.push(op); return { ok: true, formats: [] } } } }
  await assert.rejects(addFromUrl({ url, browserSessionID: id, browserSessionBrowser: 'chrome' }))
  assert.deepEqual(calls, ['probeMedia'])
})

test('browser-selected retries have no Relay ID; drafts retain only renewable source metadata', async () => {
  const calls = []
  globalThis.window = { ndm: { request: async (op, options) => { calls.push({ op, options }); return { ok: true, formats: [], task: { id: 88002, url, filename: 'video.mp4' } } } } }
  await probeMedia(url, 'firefox')
  assert.equal(calls[0].options.cookieBrowser, 'firefox')
  assert.equal(calls[0].options.browserSessionID, undefined)
  const request = draftCreationRequest('addMedia', { url, formatID: '720p', creationKey: 'operation-fixture', browserSessionID: id, browserSessionBrowser: 'chrome', cookieBrowser: 'chrome' })
  assert.equal(request.options.browserSessionID, id)
  assert.equal(request.options.browserSessionBrowser, undefined)
  const refreshed = 'e07f8107-5b2c-476f-b2ea-3e705463f29a'
  await replayDraftCreation(request, refreshed, 'chrome')
  assert.equal(calls[1].options.browserSessionID, refreshed)
  assert.equal(calls[1].options.browserSessionBrowser, 'chrome')
  assert.equal(calls[1].options.cookieBrowser, 'chrome', 'immutable creation identity keeps its original browser field')
  assert.equal(request.options.browserSessionID, id, 'replaying must not mutate the saved request')
  await checkStorage('/tmp', { id: '720p', approximateBytes: 1, componentBytes: 1 }, { url, collectionScope: 'all', container: 'compatibleMP4', browserSessionID: id, browserSessionBrowser: 'chrome' })
  assert.equal(calls[2].options.browserSessionID, id)
})
