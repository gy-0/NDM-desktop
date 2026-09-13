import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { decodeThunderLink } from '../src/shared/thunderLink.ts'
import { extractSharedLinks, resolveSharedLink } from '../src/renderer/src/lib/sharedLink.ts'
import { appendBatchLinks } from '../src/renderer/src/lib/composerBatch.ts'

const wrap = target => `thunder://${Buffer.from(`AA${target}ZZ`).toString('base64')}`

test('Thunder URLs resolve to their original supported transfer URLs', () => {
  for (const target of ['https://example.test/file.zip?sig=a%2Fb%2Bz&x=1', 'http://example.test/a.bin', 'ftp://example.test/%E6%96%87%E4%BB%B6.bin', 'https://example.test/文件.pdf']) {
    assert.equal(decodeThunderLink(wrap(target)), target)
    assert.equal(decodeThunderLink(wrap(target).replace('thunder:', 'ThUnDeR:').replace(/=+$/, '')), target)
    assert.deepEqual(resolveSharedLink(wrap(target)), { urlString: target, source: 'web', wasExtractedFromText: false })
  }
})

test('Thunder input is reviewed and deduplicated with ordinary links in the existing batch composer', () => {
  const url = 'https://example.test/guide.pdf'
  const input = `下载这个：${wrap(url)}，以及 ${url}`
  assert.deepEqual(extractSharedLinks(input), [{ urlString: url, source: 'web', wasExtractedFromText: true }])
  assert.deepEqual(appendBatchLinks([], input), [{ url }])
  assert.deepEqual(appendBatchLinks([{ url }], wrap(url)), [{ url }])
  assert.deepEqual(appendBatchLinks([], wrap(url), new Set([url])), [])
})

test('decoded addresses stay identical through paste, hydration, preflight and submission parsing', () => {
  for (const target of [
    'https://example.test/file?sig=valid!',
    'https://example.test/file?name=a&amp;signature=b',
    'https://example.test/file?next=https://youtube.com/watch?v=demo',
    'https://example.test/file?name=文件，记录！'
  ]) {
    const pasted = resolveSharedLink(wrap(target)).urlString
    assert.equal(pasted, target)
    assert.equal(resolveSharedLink(pasted).urlString, target)
    assert.deepEqual(extractSharedLinks(pasted).map(item => item.urlString), [target])
    assert.deepEqual(appendBatchLinks([], pasted).map(item => item.url), [target])
  }
  const nested = 'https://example.test/download?next=https://youtube.com/watch?v=demo'
  assert.deepEqual(extractSharedLinks(`下载：${nested} 完毕`).map(item => item.urlString), [nested])
})

test('invalid, nested, local-file and unsupported Thunder targets never become download requests', () => {
  const invalid = [
    '', 'thunder://', 'thunder://not-base64!', 'thunder://A',
    'thunder://' + Buffer.from('https://example.test/file.bin').toString('base64'),
    'thunder://' + Buffer.from([65, 65, 0xff, 90, 90]).toString('base64'),
    wrap('file:///etc/passwd'), wrap('javascript:alert(1)'), wrap('data:text/plain,hello'),
    wrap('sftp://example.test/file'), wrap('magnet:?xt=urn:btih:abc'), wrap(wrap('https://example.test/a')),
    wrap('https://example.test/a\r\nInjected:true'), wrap('https://example.test/a\0'),
    wrap('https://example.test/a\x7f'), wrap(' https://example.test/a'), wrap('https:///'),
    wrap('https:example.test/a.bin'), wrap('https:/example.test/a.bin'),
    wrap('https:\\example.test\\a.bin'), wrap('ftp:example.test/a.bin'),
    wrap('https://example.test/' + 'a'.repeat(32_768))
  ]
  for (const value of invalid) {
    assert.equal(decodeThunderLink(value), null, value.slice(0, 80))
    if (value.startsWith('thunder:')) assert.equal(resolveSharedLink(value), null, value.slice(0, 80))
  }
})

test('a decoded signed HTTP URL reaches a real server without changing its path or query', async () => {
  const payload = Buffer.from('NDM Thunder wrapper transfer fixture')
  const expectedPath = '/fixture%2Fpart.bin?signature=A%2FB%2BC&name=a&amp;next=https://youtube.com/watch?v=fixture&sig=valid!'
  let observedPath
  const server = createServer((request, response) => {
    observedPath = request.url
    response.writeHead(request.url === expectedPath ? 200 : 403, { 'Content-Type': 'application/octet-stream' })
    response.end(payload)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const target = `http://127.0.0.1:${server.address().port}${expectedPath}`
    const batch = appendBatchLinks([], wrap(target))
    assert.equal(batch.length, 1)
    const response = await fetch(resolveSharedLink(batch[0].url).urlString)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload)
    assert.equal(observedPath, expectedPath)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
