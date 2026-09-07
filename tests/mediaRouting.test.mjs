import assert from 'node:assert/strict'
import test from 'node:test'
import { addFromUrl } from '../src/renderer/src/lib/store.ts'

test('unknown and unavailable classification never turn known video pages into ordinary downloads', async () => {
  for (const unavailable of [false, true]) {
    const operations = []
    globalThis.window = { ndm: {
      classifyURL: async () => { if (unavailable) throw new Error('Classifier unavailable'); return { kind: 'unknown' } },
      status: async () => 'live',
      request: async op => { operations.push(op); return { ok: true, formats: [] } }
    } }
    await assert.rejects(addFromUrl('https://www.bilibili.com/video/BV1example?p=3'))
    assert.ok(operations.includes('probeMedia'), 'Known page must still get media analysis')
    assert.ok(!operations.includes('add'), 'A failed page parse must not create an ordinary task')
  }
})

test('affirmative binary responses and unknown ordinary file links keep direct downloads', async () => {
  for (const [url, kind] of [
    ['https://www.bilibili.com/download.bin', 'binary'],
    ['https://example.test/archive.zip', 'unknown']
  ]) {
    const operations = []
    globalThis.window = { ndm: {
      classifyURL: async () => ({ kind }),
      request: async op => { operations.push(op); return { task: { id: 980001, url, filename: 'archive.zip' } } }
    } }
    await addFromUrl(url)
    assert.deepEqual(operations, ['add'])
  }
})

test('confirmed HTML video pages cannot fall back to saving a webpage', async () => {
  const operations = []
  globalThis.window = { ndm: {
    classifyURL: async () => ({ kind: 'html' }),
    status: async () => 'live',
    request: async op => { operations.push(op); return { ok: true, formats: [] } }
  } }
  await assert.rejects(addFromUrl('https://vimeo.com/123456/abcdef1234'))
  assert.deepEqual(operations, ['probeMedia'])
})
