import assert from 'node:assert/strict'
import test from 'node:test'
import { appendBatchLinks, batchLinkIdentity } from '../src/renderer/src/lib/composerBatch.ts'

test('batch draft keeps failures and does not re-add accepted or repeated URLs', () => {
  const failed = { url: 'https://example.com/report.pdf', failed: true }
  assert.deepEqual(appendBatchLinks([failed], 'https://example.com/accepted.zip\nhttps://example.com/report.pdf\nhttps://example.com/new.zip\nhttps://example.com/new.zip', new Set(['https://example.com/accepted.zip'])), [failed, { url: 'https://example.com/new.zip' }])
})

test('batch identities keep file names readable without exposing query parameters', () => {
  assert.deepEqual(batchLinkIdentity('https://www.example.com/folder/%E8%AE%BE%E8%AE%A1%20Kit.zip?token=private'), { title: '设计 Kit.zip', detail: 'example.com' })
  assert.deepEqual(batchLinkIdentity('magnet:?xt=urn:btih:test&dn=Design%20Kit'), { title: 'Design Kit', detail: 'BitTorrent' })
  assert.deepEqual(batchLinkIdentity('https://example.com/'), { title: 'example.com', detail: 'example.com' })
})
