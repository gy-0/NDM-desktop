import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HTTPResponseGuard, validateGuardedResponse } from '../src/main/windows/httpResponseGuard.ts'
const origin = 'https://fixture.test/file'
const identity = { version: 1, resourceHash: createHash('sha256').update(origin).digest('hex'), etag: '"one"', totalBytes: 4 }
function response(url = origin, headers = {}, status = 200, body = 'abcd') {
  const result = new Response(body, { status, headers: { etag: '"one"', 'content-length': '4', ...headers } })
  Object.defineProperty(result, 'url', { value: url })
  return result
}
test('response guard rejects changed ETag, effective URL, size, encoding and wrong ranges', () => {
  validateGuardedResponse(response(), identity)
  for (const value of [response(origin, {etag:'"two"'}), response('https://other.test/file'), response(origin, {'content-length':'5'}), response(origin, {'content-encoding':'gzip'})]) {
    assert.throws(() => validateGuardedResponse(value, identity))
  }
  validateGuardedResponse(response(origin, {'content-range':'bytes 1-3/4','content-length':'3'},206,'bcd'),identity,'bytes=1-')
  assert.throws(() => validateGuardedResponse(response(), identity, 'bytes=1-'))
  assert.throws(() => validateGuardedResponse(response(origin, {'content-range':'bytes 0-2/4','content-length':'3'},206,'abc'),identity,'bytes=1-'))
})
test('changed responses expose zero bytes and latch the whole transfer', async t => {
  let calls = 0
  const guard = new HTTPResponseGuard(async () => { calls++; return response(origin, {etag:'"two"'}) })
  t.after(() => guard.close())
  const route = await guard.register(origin, [], identity)
  const blocked = await fetch(route.url)
  assert.equal(blocked.status, 412)
  assert.equal((await blocked.arrayBuffer()).byteLength, 0)
  assert.ok(route.failure())
  const retry = await fetch(route.url)
  assert.equal(retry.status, 410)
  assert.equal(calls, 1)
})
test('fixed upstream transport retains proxy selection and strips credentials at cross-origin redirect', async t => {
  const requests = []
  const finalURL = 'https://cdn.test/file'
  const guard = new HTTPResponseGuard(async (url, headers, signal, proxy) => {
    requests.push({url,headers,proxy})
    assert.equal(signal.aborted, false)
    return url === origin ? response(origin, {location:finalURL},302,'') : response(finalURL)
  })
  t.after(() => guard.close())
  const route = await guard.register(origin, ['Cookie: secret', 'Authorization: secret', 'X-Custom-Key: secret'],
    {...identity,resourceHash:createHash('sha256').update(finalURL).digest('hex')}, 'socks5://127.0.0.1:8888')
  const received = await fetch(route.url)
  assert.equal(await received.text(), 'abcd')
  assert.equal(requests[0].headers.cookie, 'secret')
  for (const key of ['cookie','authorization','x-custom-key']) assert.equal(requests[1].headers[key], undefined)
  assert.equal(requests[1].proxy, 'socks5://127.0.0.1:8888')
  // Header preservation is case-insensitive: the validated entity conditions remain.
  assert.equal(Object.entries(requests[1].headers).find(([key])=>key.toLowerCase()==='if-match')[1], '"one"')
  route.release()
  assert.equal((await fetch(route.url)).status, 410)
})
