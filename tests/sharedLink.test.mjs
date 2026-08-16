import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractSharedLinks, resolveSharedLink } from '../src/renderer/src/lib/sharedLink.ts'

const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=NDM%20Test'

test('magnet links are accepted as first-class download input', () => {
  assert.deepEqual(resolveSharedLink(magnet), {
    urlString: magnet,
    source: 'magnet',
    wasExtractedFromText: false
  })
})

test('magnet links are extracted from surrounding Chinese share text', () => {
  const matches = extractSharedLinks(`给你这个磁力链：${magnet}，下载看看`)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].urlString, magnet)
  assert.equal(matches[0].source, 'magnet')
  assert.equal(matches[0].wasExtractedFromText, true)
})

test('unsupported URI schemes are ignored', () => {
  assert.equal(resolveSharedLink('file:///C:/secret.txt'), null)
})
