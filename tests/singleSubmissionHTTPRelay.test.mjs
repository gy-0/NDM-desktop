import test from 'node:test'
import assert from 'node:assert/strict'
import { SingleSubmissionHTTPRelay } from '../src/main/windows/singleSubmissionHTTPRelay.ts'
const body = () => new Uint8Array([0, 255, 61, 38]).buffer
const origin = 'https://fixture.test/export'

test('POST relay preserves binary body, headers and proxy; concurrent and later attempts cannot replay', async t => {
  let calls = 0
  const relay = new SingleSubmissionHTTPRelay(async (url, headers, signal, proxy, request) => {
    calls++
    assert.equal(url, origin); assert.equal(proxy, 'socks5://127.0.0.1:8888')
    assert.equal(request.method, 'POST'); assert.deepEqual(new Uint8Array(request.body), new Uint8Array(body()))
    assert.equal(headers.cookie, 'session'); assert.equal(headers['content-type'], 'application/octet-stream')
    assert.equal(headers.range, undefined); assert.equal(headers['content-length'], undefined)
    assert.equal(headers['accept-encoding'], 'identity')
    return new Response('file', { headers: { 'content-length': '4', 'accept-ranges': 'bytes' } })
  })
  t.after(() => relay.close())
  const original = body()
  const route = await relay.register(origin, ['Cookie: session', 'Content-Type: application/octet-stream', 'Range: bytes=9-', 'Content-Length: 900'], original, 'socks5://127.0.0.1:8888')
  new Uint8Array(original).fill(42)
  const suffix = await fetch(route.url, { headers: { Range: 'bytes=1-' } })
  assert.equal(suffix.status, 416); assert.equal(calls, 0)
  const replies = await Promise.all([fetch(route.url, { headers: { Range: 'bytes=0-' } }), fetch(route.url)])
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 410])
  const success = replies.find(r => r.status === 200)
  assert.equal(success.headers.get('accept-ranges'), 'none'); assert.equal(await success.text(), 'file')
  assert.equal((await fetch(route.url)).status, 410); assert.equal(calls, 1)
  assert.equal(route.failure(), undefined)
})

test('303 follows GET without body or cross-origin secrets', async t => {
  const calls = []
  const relay = new SingleSubmissionHTTPRelay(async (url, headers, signal, proxy, request) => {
    calls.push({ url, headers, request })
    return calls.length === 1 ? new Response(null, { status: 303, headers: { location: 'https://cdn.test/result' } }) : new Response('done')
  })
  t.after(() => relay.close())
  const route = await relay.register(origin, ['Cookie: secret', 'Authorization: secret', 'X-Key: secret', 'Content-Type: text/plain'], body())
  assert.equal(await (await fetch(route.url)).text(), 'done')
  assert.equal(calls.length, 2); assert.equal(calls[0].request.method, 'POST'); assert.equal(calls[1].request, undefined)
  for (const key of ['cookie', 'authorization', 'x-key', 'content-type']) assert.equal(calls[1].headers[key], undefined)
})

for (const [name, makeResponse] of [
  ['body-preserving redirect', () => new Response(null, { status: 307, headers: { location: '/again' } })],
  ['HTTPS downgrade', () => new Response(null, { status: 303, headers: { location: 'http://fixture.test/result' } })],
  ['error body', () => new Response('secret error', { status: 403 })],
  ['unexpected partial body', () => new Response('part', { status: 206 })],
  ['encoded body', () => new Response('decoded', { headers: { 'content-encoding': 'gzip' } })]
]) test(`POST relay rejects ${name} without replay`, async t => {
  let calls = 0
  const relay = new SingleSubmissionHTTPRelay(async () => { calls++; return makeResponse() })
  t.after(() => relay.close())
  const route = await relay.register(origin, [], body())
  const reply = await fetch(route.url)
  assert.equal(reply.status, 502); assert.equal(await reply.text(), '')
  assert.ok(route.failure()); assert.equal((await fetch(route.url)).status, 410); assert.equal(calls, 1)
})

test('network failure and truncated response cannot lead to a second submission', async t => {
  for (const failing of [async () => { throw new Error('connection lost') }, async () => new Response('short', { headers: { 'content-length': '20' } })]) {
    let calls = 0
    const relay = new SingleSubmissionHTTPRelay(async () => { calls++; return failing() })
    t.after(() => relay.close())
    const route = await relay.register(origin, [], body())
    try { const reply = await fetch(route.url); await reply.arrayBuffer() } catch { /* truncated transfer rejects */ }
    assert.ok(route.failure()); assert.equal((await fetch(route.url)).status, 410); assert.equal(calls, 1)
  }
})

test('release aborts an ongoing upstream and prevents retry', async t => {
  let signal, calls = 0
  const relay = new SingleSubmissionHTTPRelay(async (_url, _headers, suppliedSignal) => {
    signal = suppliedSignal; calls++
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); suppliedSignal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }) }
    }))
  })
  t.after(() => relay.close())
  const route = await relay.register(origin, [], body())
  const reply = await fetch(route.url), reader = reply.body.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]))
  route.release(); assert.equal(signal.aborted, true)
  await reader.cancel().catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(route.failure(), undefined, 'user cancellation is not a failed transfer')
  assert.equal((await fetch(route.url)).status, 410); assert.equal(calls, 1)
})
