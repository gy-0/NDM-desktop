import test from 'node:test'
import assert from 'node:assert/strict'
import { relayDistribution, relayStoreURL } from '../src/shared/relayDistribution.ts'

const listing = 'https://chromewebstore.google.com/detail/ndm-relay/' + 'abcdefghijklmnop'.repeat(2)

test('packaged apps never offer development installation when no store listing is configured', () => {
  assert.deepEqual(relayDistribution(true), { mode: 'unavailable', url: null })
  assert.deepEqual(relayDistribution(true, ' '), { mode: 'unavailable', url: null })
  assert.deepEqual(relayDistribution(false), { mode: 'development', url: null })
})

test('an explicitly configured listing is shared by development and packaged apps', () => {
  for (const packaged of [true, false]) assert.deepEqual(relayDistribution(packaged, listing), { mode: 'store', url: listing })
  assert.equal(relayStoreURL('  ' + listing + '  '), listing)
})

test('invalid or redirected install destinations fail rather than silently advertising them', () => {
  for (const url of ['https://example.com/detail/' + 'a'.repeat(32), 'http://chromewebstore.google.com/detail/' + 'a'.repeat(32),
    listing + '?redirect=https://example.com', listing + '#test', listing.replace('https://', 'https://user@'),
    'https://chromewebstore.google.com/search/NDM', 'https://chromewebstore.google.com/detail/not-an-extension', 'javascript:alert(1)']) {
    assert.throws(() => relayDistribution(true, url))
  }
})
