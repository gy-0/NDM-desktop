import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dragCarriesDownloadLink, resolveDroppedInput } from '../src/renderer/src/lib/dropInput.ts'

const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=NDM%20Drop'

test('browser link drags open a real downloadable URL', () => {
  assert.deepEqual(resolveDroppedInput({
    uriList: '# browser source\nhttps://example.com/file.zip',
    plainText: 'Example download',
    hasFiles: false
  }), {
    accepted: true,
    link: {
      urlString: 'https://example.com/file.zip',
      source: 'web',
      wasExtractedFromText: true
    }
  })
})

test('shared magnet text is accepted through the same resolver as the composer', () => {
  const result = resolveDroppedInput({ uriList: '', plainText: `下载：${magnet}`, hasFiles: false })
  assert.equal(result.accepted, true)
  if (result.accepted) assert.equal(result.link.urlString, magnet)
})

test('local files are rejected instead of pretending to download or upload them', () => {
  assert.deepEqual(resolveDroppedInput({
    uriList: 'file:///Users/example/Desktop/movie.mp4',
    plainText: '',
    hasFiles: true
  }), { accepted: false, reason: 'localFile' })
})

test('unsupported drag payloads are rejected clearly', () => {
  assert.deepEqual(resolveDroppedInput({
    uriList: '',
    plainText: 'javascript:alert(1)',
    hasFiles: false
  }), { accepted: false, reason: 'unsupported' })
})

test('drag affordance only promises support for link-shaped payloads', () => {
  assert.equal(dragCarriesDownloadLink(['text/plain']), true)
  assert.equal(dragCarriesDownloadLink(['text/uri-list']), true)
  assert.equal(dragCarriesDownloadLink(['Files', 'text/uri-list']), false)
  assert.equal(dragCarriesDownloadLink(['Files']), false)
})
