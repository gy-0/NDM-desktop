import test from 'node:test'
import assert from 'node:assert/strict'

// The cookie-domain matcher is exported from a main-process module; import it
// through the shared esbuild pipeline like other behavior tests do.
const { cookieMatchesHost, cookiesForURL, rowsToCookieHeader, parseNetscapeCookieFile } = await import(
  '../src/main/browserCookies.ts'
)

test('Netscape HttpOnly records remain available to authenticated downloads', () => {
  const rows = parseNetscapeCookieFile('# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-fixture\r\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].domain, '.youtube.com')
  assert.equal(rowsToCookieHeader(cookiesForURL(rows, 'https://www.youtube.com/watch')), 'SID=private-fixture')
})

test('cookie headers respect path boundaries, transport and expiry', () => {
  const row = { domain: '.example.com', flag: true, path: '/private', secure: true, expiry: 0, name: 'session', value: 'fixture' }
  assert.equal(cookiesForURL([row], 'https://www.example.com/private/file').length, 1)
  for (const url of ['https://www.example.com/private-other/file', 'http://www.example.com/private/file', 'https://www.example.com/public']) {
    assert.equal(cookiesForURL([row], url).length, 0)
  }
  assert.equal(cookiesForURL([{ ...row, expiry: 1 }], 'https://www.example.com/private').length, 0)
})
const { hasProxyTargetPointer } = await import('../src/renderer/src/lib/format.ts')

test('cookie domains match hosts per RFC 6265 semantics', () => {
  assert.equal(cookieMatchesHost('.cambridge.org', 'www.cambridge.org'), true)
  assert.equal(cookieMatchesHost('.cambridge.org', 'cambridge.org'), true)
  assert.equal(cookieMatchesHost('.cambridge.org', 'evilcambridge.org'), false)
  assert.equal(cookieMatchesHost('.cambridge.org', 'cambridge.org.evil.example'), false)
  assert.equal(cookieMatchesHost('ezproxy.library.mcmaster.ca', 'ezproxy.library.mcmaster.ca'), true)
  assert.equal(cookieMatchesHost('library.mcmaster.ca', 'ezproxy.library.mcmaster.ca'), false)
})

test('cookie scoping keeps only target-domain cookies', () => {
  const rows = [
    { domain: '.cambridge.org', flag: true, path: '/', secure: true, expiry: 0, name: 'session', value: 'a' },
    { domain: '.zhihu.com', flag: true, path: '/', secure: false, expiry: 0, name: '_zap', value: 'b' },
    { domain: 'www.cambridge.org', flag: false, path: '/', secure: false, expiry: 0, name: 'host', value: 'c' }
  ]
  const scoped = cookiesForURL(rows, 'https://www.cambridge.org/core/downloads/thing.zip')
  assert.deepEqual(scoped.map((row) => row.name).sort(), ['host', 'session'])
  const header = rowsToCookieHeader(scoped)
  assert.match(header, /session=a/)
  assert.match(header, /host=c/)
  assert.doesNotMatch(header, /_zap/)
})

test('empty or mismatched cookie sets produce no header', () => {
  assert.equal(rowsToCookieHeader([]), '')
  const rows = [
    { domain: '.zhihu.com', flag: true, path: '/', secure: false, expiry: 0, name: '_zap', value: 'b' }
  ]
  assert.equal(rowsToCookieHeader(cookiesForURL(rows, 'https://www.cambridge.org/x.zip')), '')
})

test('proxy target pointer detection covers ezproxy shapes and rejects plain URLs', () => {
  assert.equal(hasProxyTargetPointer('https://ezproxy.library.mcmaster.ca/login?url=https%3A%2F%2Fwww.cambridge.org%2Ff.zip'), true)
  assert.equal(hasProxyTargetPointer('https://proxy.example/redirect?target=https%3A//a.org/f.pdf'), true)
  assert.equal(hasProxyTargetPointer('https://www.youtube.com/watch?v=abc'), false)
  assert.equal(hasProxyTargetPointer('https://a.org/page?q=not+a+url'), false)
  assert.equal(hasProxyTargetPointer('not a url'), false)
})
