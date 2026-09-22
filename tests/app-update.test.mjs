import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppUpdateChecker, publicReleaseReply } from '../src/main/appUpdate.ts'

const release = { draft: false, prerelease: false, tag_name: 'v2026.9.20', published_at: '2026-09-22T00:00:00Z' }
test('update comparison is numeric and unknown formats never claim current', () => {
  assert.equal(publicReleaseReply(release, '2026.9.19', 1).relation, 'newer')
  assert.equal(publicReleaseReply(release, '2026.9.20', 1).relation, 'current')
  assert.equal(publicReleaseReply(release, '2026.10.1', 1).relation, 'older')
  assert.equal(publicReleaseReply({ ...release, tag_name: 'nightly' }, '2026.9.20', 1).relation, 'unknown')
  assert.equal(publicReleaseReply({ ...release, html_url: 'https://untrusted.test' }, '2026.9.19', 1).url, 'https://github.com/gy-0/NDM-desktop/releases/tag/v2026.9.20')
  for (const invalid of [null, {}, { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: '\nrelease' }, { ...release, published_at: null }]) assert.equal(publicReleaseReply(invalid, '2026.9.19', 1).status, 'error')
})
test('check uses only the fixed public endpoint without browser credentials and coalesces requests', async () => {
  let requests = 0, releaseFetch
  const check = createAppUpdateChecker('2026.9.19', async (url, options) => {
    requests++
    assert.equal(url, 'https://api.github.com/repos/gy-0/NDM-desktop/releases/latest')
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined)
    await new Promise(resolve => { releaseFetch = resolve })
    return new Response(JSON.stringify(release))
  })
  const a = check(), b = check(); assert.equal(a, b); assert.equal(requests, 1)
  releaseFetch(); assert.equal((await a).relation, 'newer')
})
test('absent release, rate limit and network failure remain distinct and retryable', async () => {
  let attempt = 0
  const check = createAppUpdateChecker('2026.9.19', async () => {
    attempt++
    if (attempt === 1) throw new Error('private transport details')
    return new Response(null, { status: 404 })
  })
  assert.deepEqual(await check(), { status: 'error', reason: 'network' })
  assert.equal((await check()).status, 'unpublished')
  for (const status of [403, 429]) assert.deepEqual(await createAppUpdateChecker('1.0.0', async () => new Response(null, { status }))(), { status: 'error', reason: 'rateLimit' })
})
test('oversized or malformed responses do not produce a release and excess data is canceled', async () => {
  let canceled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) }, cancel() { canceled = true } })
  assert.deepEqual(await createAppUpdateChecker('1.0.0', async () => new Response(body))(), { status: 'error', reason: 'invalid' })
  assert.equal(canceled, true)
  assert.deepEqual(await createAppUpdateChecker('1.0.0', async () => new Response('{'))(), { status: 'error', reason: 'invalid' })
})
test('response-body stalls are bounded by the same request timeout', async () => {
  let aborted = false
  const check = createAppUpdateChecker('1.0.0', async (_url, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')) }, { once: true }) }
  })))
  assert.deepEqual(await check(), { status: 'error', reason: 'network' })
  assert.equal(aborted, true)
})
