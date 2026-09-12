import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classify,
  classifyURLWith,
  GET_PROBE_RANGE,
  MAX_PROBE_BODY_BYTES,
  MAX_PROBE_HOPS,
  nextProbeMethod,
  onceRequestArgs,
  parseHeaders,
  probeDecision,
  probeChains
} from '../src/main/urlClassificationRules.ts'

const raw = (extra = {}) => ({
  kind: 'unknown', contentType: '', disposition: null, contentLength: null, method: 'HEAD', ...extra
})

test('classification: binary types, media prefixes, attachments, html and unknown', () => {
  for (const type of ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed', 'application/vnd.rar', 'application/pdf', 'application/octet-stream', 'application/msword', 'application/epub+zip', 'application/x-mobipocket-ebook', 'application/dmg', 'application/x-apple-diskimage', 'application/vnd.android.package-archive']) {
    assert.equal(classify(type, null), 'binary', type)
  }
  for (const type of ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'image/png', 'image/jpeg']) {
    assert.equal(classify(type, null), 'binary', type)
  }
  // Parameters are ignored, case is normalized.
  assert.equal(classify('Application/PDF; charset=binary', null), 'binary')
  // An attachment disposition wins even over an html-looking type.
  assert.equal(classify('text/html', 'attachment; filename="page.htm"'), 'binary')
  assert.equal(classify('application/x-weird-format', 'ATTACHMENT; filename="a.bin"'), 'binary')
  // Inline dispositions do not make something binary.
  assert.equal(classify('application/x-weird-format', 'inline; filename="a.bin"'), 'unknown')
  assert.equal(classify('text/html', null), 'html')
  assert.equal(classify('text/html; charset=utf-8', null), 'html')
  assert.equal(classify('application/xhtml+xml', null), 'html')
  assert.equal(classify('application/json', null), 'unknown')
  assert.equal(classify('text/plain', null), 'unknown')
  assert.equal(classify('', null), 'unknown')
  assert.equal(classify('application/x-unknown-format', null), 'unknown')
})

test('downgrade matrix: HEAD failures and unknown fall back to GET; decisive verdicts and redirects do not', () => {
  // Blocked at the network layer / timeout — no HEAD answer at all.
  assert.equal(nextProbeMethod(null, 'HEAD'), 'GET')
  // Server refused the method outright.
  assert.equal(nextProbeMethod(raw({ status: 405 }), 'HEAD'), 'GET')
  assert.equal(nextProbeMethod(raw({ status: 501 }), 'HEAD'), 'GET')
  // HEAD answered with an unrecognized type — try the ranged GET.
  assert.equal(nextProbeMethod(raw({ status: 200 }), 'HEAD'), 'GET')
  assert.equal(nextProbeMethod(raw({ status: 200, contentType: 'application/json' }), 'HEAD'), 'GET')
  // Decisive verdicts are final: html keeps the cookie retry upstream, and
  // unknown-with-file is a filename-heuristic matter.
  assert.equal(nextProbeMethod(raw({ status: 200, kind: 'binary' }), 'HEAD'), null)
  assert.equal(nextProbeMethod(raw({ status: 200, kind: 'html' }), 'HEAD'), null)
  // A redirect hop is owned by the hop loop, not by the method fallback.
  assert.equal(nextProbeMethod(raw({ status: 302, location: 'https://cdn.example/a.zip' }), 'HEAD'), null)
  // Unknown is status-agnostic (the task matrix: HEAD unknown → GET): the
  // GET either rescues a real Content-Type or harmlessly reconfirms it.
  assert.equal(nextProbeMethod(raw({ status: 404 }), 'HEAD'), 'GET')
  assert.equal(nextProbeMethod(raw({ status: 500 }), 'HEAD'), 'GET')
  // A GET is never upgraded again — one fallback per URL.
  assert.equal(nextProbeMethod(null, 'GET'), null)
  assert.equal(nextProbeMethod(raw({ status: 405 }), 'GET'), null)
  assert.equal(nextProbeMethod(raw({ status: 200 }), 'GET'), null)
})

test('wire shaping: only the GET probe carries Range; cookies ride both', () => {
  const head = onceRequestArgs({ url: 'https://x.example/a.zip', method: 'HEAD' })
  assert.equal(head.method, 'HEAD')
  assert.equal('Range' in head.headers, false)
  assert.equal(head.headers['User-Agent'], 'Mozilla/5.0 (Macintosh) NDM-probe')
  const get = onceRequestArgs({ url: 'https://x.example/a.zip', method: 'GET', cookieHeader: 'sid=1' })
  assert.equal(get.method, 'GET')
  assert.equal(get.headers.Range, 'bytes=0-0')
  assert.equal(GET_PROBE_RANGE, 'bytes=0-0')
  assert.equal(get.headers.Cookie, 'sid=1')
  const headWithCookie = onceRequestArgs({ url: 'https://x.example/a.zip', method: 'HEAD', cookieHeader: 'sid=1' })
  assert.equal(headWithCookie.headers.Cookie, 'sid=1')
  assert.equal('Range' in headWithCookie.headers, false)
})

test('header parsing: real sizes survive HEAD; the ranged GET stub size never does', () => {
  const head = parseHeaders({ 'content-length': '734003200', 'content-type': 'application/zip' }, 'https://x.example/', 'HEAD')
  assert.equal(head.contentLength, 734003200)
  const ranged = parseHeaders({ 'content-length': '1', 'content-type': 'application/zip' }, 'https://x.example/', 'GET')
  assert.equal(ranged.contentLength, null)
  const arrayHeaders = parseHeaders({ 'content-disposition': ['attachment; filename="a.zip"'] }, 'https://x.example/', 'GET')
  assert.equal(arrayHeaders.disposition, 'attachment; filename="a.zip"')
  const relative = parseHeaders({ location: '/elsewhere/b.mp4' }, 'https://x.example/here', 'HEAD')
  assert.equal(relative.location, 'https://x.example/elsewhere/b.mp4')
  const absolute = parseHeaders({ location: 'https://cdn.example/c.exe' }, 'https://x.example/here', 'HEAD')
  assert.equal(absolute.location, 'https://cdn.example/c.exe')
})

test('hop routing: redirects follow hop by hop and stop after four', () => {
  const redirect = { ...raw({ status: 302 }), location: 'https://cdn.example/file.bin' }
  assert.deepEqual(probeDecision(redirect, 0), { action: 'continue', location: 'https://cdn.example/file.bin' })
  assert.deepEqual(probeDecision(redirect, MAX_PROBE_HOPS - 1), { action: 'continue', location: 'https://cdn.example/file.bin' })
  // No hops left — the last redirect answer becomes the verdict.
  assert.equal(probeDecision(redirect, MAX_PROBE_HOPS).action, 'return')
  assert.equal(probeDecision({ ...redirect, status: 200 }, 0).action, 'return')
  assert.equal(probeDecision({ ...redirect, location: undefined }, 0).action, 'return')
  assert.equal(probeDecision(raw({ status: 200 }), 0).action, 'return')
})

/**
 * A scripted wire: every call consumes one entry from the method's queue.
 * `head: null` means the request itself failed (blocked/timeout); entries
 * are either a RawProbe or an Error.
 */
const wire = (script) => {
  const calls = []
  const once = (request) => {
    calls.push(request)
    const scripted = script[request.method]?.shift()
    if (scripted === undefined || scripted === null) return Promise.reject(new Error('blocked'))
    if (scripted instanceof Error) return Promise.reject(scripted)
    return Promise.resolve({ ...raw(), ...scripted, method: request.method })
  }
  return { once, calls }
}

test('chain: HEAD blocked → same-URL ranged GET rescues the verdict', async () => {
  const { once, calls } = wire({
    HEAD: [null],
    GET: [{ status: 206, kind: 'binary', contentType: 'application/zip' }]
  })
  const result = await probeChains({ url: 'https://x.example/a.zip', once })
  assert.equal(result.kind, 'binary')
  assert.equal(result.contentType, 'application/zip')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'HEAD')
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].url, calls[0].url)
  assert.equal(calls[1].headers?.Range ?? onceRequestArgs(calls[1]).headers.Range, 'bytes=0-0')
})

test('chain: HEAD 405 → ranged GET answers for the same URL', async () => {
  const { once, calls } = wire({
    HEAD: [{ status: 405, kind: 'unknown' }],
    GET: [{ status: 200, kind: 'binary', contentType: 'application/pdf' }]
  })
  const result = await probeChains({ url: 'https://x.example/paper.pdf', once })
  assert.equal(result.kind, 'binary')
  assert.equal(result.contentType, 'application/pdf')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].url, calls[0].url)
})

test('chain: HEAD 501 → ranged GET answers for the same URL', async () => {
  const { once, calls } = wire({
    HEAD: [{ status: 501, kind: 'unknown' }],
    GET: [{ status: 200, kind: 'binary', contentType: 'application/zip' }]
  })
  const result = await probeChains({ url: 'https://x.example/a.zip', once })
  assert.equal(result.kind, 'binary')
  assert.equal(calls.length, 2)
})

test('chain: HEAD 200 unknown → ranged GET decisive verdict wins; GET unknown keeps HEAD answer', async () => {
  const decisive = wire({
    HEAD: [{ status: 200, kind: 'unknown', contentType: 'application/json' }],
    GET: [{ status: 200, kind: 'binary', contentType: 'application/octet-stream' }]
  })
  const decisiveResult = await probeChains({ url: 'https://x.example/blob', once: decisive.once })
  assert.equal(decisiveResult.kind, 'binary')
  assert.equal(decisive.calls.length, 2)
  // GET also says unknown → HEAD's answer stands (GET never erases it).
  const bothUnknown = wire({
    HEAD: [{ status: 200, kind: 'unknown', contentType: 'application/json' }],
    GET: [{ status: 200, kind: 'unknown', contentType: 'text/plain' }]
  })
  const bothResult = await probeChains({ url: 'https://x.example/blob', once: bothUnknown.once })
  assert.equal(bothResult.kind, 'unknown')
  assert.equal(bothResult.contentType, 'application/json')
  assert.equal(bothUnknown.calls.length, 2)
})

test('chain: HEAD 200 binary/html never spend a GET', async () => {
  const binary = wire({ HEAD: [{ status: 200, kind: 'binary', contentType: 'application/zip' }] })
  const binaryResult = await probeChains({ url: 'https://x.example/a.zip', once: binary.once })
  assert.equal(binaryResult.kind, 'binary')
  assert.equal(binary.calls.length, 1)

  const html = wire({ HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }] })
  const htmlResult = await probeChains({ url: 'https://x.example/page', once: html.once })
  assert.equal(htmlResult.kind, 'html')
  assert.equal(html.calls.length, 1)
})

test('chain: redirect hops follow with GET fallback available at every hop', async () => {
  const { once, calls } = wire({
    HEAD: [
      { status: 302, kind: 'unknown', location: 'https://cdn.example/a.zip' },
      null
    ],
    GET: [
      { status: 206, kind: 'binary', contentType: 'application/zip', contentLength: null }
    ]
  })
  const result = await probeChains({ url: 'https://x.example/a.zip', once })
  assert.equal(result.kind, 'binary')
  assert.equal(result.contentType, 'application/zip')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://x.example/a.zip')
  assert.equal(calls[1].url, 'https://cdn.example/a.zip')
  assert.equal(calls[1].method, 'HEAD')
  assert.equal(calls[2].url, 'https://cdn.example/a.zip')
  assert.equal(calls[2].method, 'GET')
})

test('chain: everything blocked → the last error surfaces; a prior hop verdict is kept', async () => {
  const never = wire({ HEAD: [null], GET: [null] })
  await assert.rejects(
    probeChains({ url: 'https://x.example/a.zip', once: never.once }),
    /blocked/
  )
  assert.equal(never.calls.length, 2)

  // An earlier hop's verdict still stands when the next hop goes dark.
  const hopThenDark = wire({
    HEAD: [{ status: 302, kind: 'unknown', location: 'https://cdn.example/a.zip' }, null],
    GET: [null]
  })
  const kept = await probeChains({ url: 'https://x.example/a.zip', once: hopThenDark.once })
  assert.equal(kept.kind, 'unknown')
  assert.equal(kept.contentType, '')
})

test('chain: HEAD refusal hands its verdict to the ranged GET', async () => {
  // 405's own headers (here: html) describe the refusal, not the resource;
  // the GET's answer replaces them.
  const { once, calls } = wire({
    HEAD: [{ status: 405, kind: 'html', contentType: 'text/html' }],
    GET: [{ status: 200, kind: 'binary', contentType: 'application/zip' }]
  })
  const result = await probeChains({ url: 'https://x.example/a.zip', once })
  assert.equal(result.kind, 'binary')
  assert.equal(calls.length, 2)
})

test('classifyURLWith: html answer retries with the session; binary wins with cookies', async () => {
  // HTML without a cookie exporter stays html, no second chain.
  const noExporter = wire({ HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }] })
  const noExportResult = await classifyURLWith(noExporter.once, 'https://x.example/page')
  assert.equal(noExportResult.kind, 'html')
  assert.equal(noExportResult.sessionNote, undefined)
  assert.equal(noExporter.calls.length, 1)

  // HTML + exporter → second chain; the cookie session finds a file.
  const withCookies = wire({
    HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }, { status: 200, kind: 'binary', contentType: 'application/zip' }]
  })
  const exported = await classifyURLWith(
    withCookies.once,
    'https://x.example/paper.pdf',
    () => Promise.resolve('sid=42')
  )
  assert.equal(exported.kind, 'binary')
  assert.equal(exported.cookieUsed, 'sid=42')
  assert.equal(withCookies.calls.length, 2)
  assert.equal(withCookies.calls[1].cookieHeader, 'sid=42')

  // HTML + session still html → surface the session note.
  const stillHtml = wire({
    HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }, { status: 200, kind: 'html', contentType: 'text/html' }]
  })
  const noted = await classifyURLWith(stillHtml.once, 'https://x.example/page', () => Promise.resolve('sid=42'))
  assert.equal(noted.kind, 'html')
  assert.equal(noted.sessionNote, '未能识别可下载的文件。请打开来源网页确认。')
  assert.doesNotMatch(noted.sessionNote, /登录|Cookie|会话/)

  // Exporter missing a header → note instead of a retry.
  const noCookie = wire({ HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }] })
  const noCookieResult = await classifyURLWith(noCookie.once, 'https://x.example/page', () => Promise.resolve(null))
  assert.equal(noCookieResult.sessionNote, '未能识别可下载的文件。请打开来源网页确认。')
  assert.doesNotMatch(noCookieResult.sessionNote, /登录|Cookie|会话/)
  assert.equal(noCookie.calls.length, 1)
})

test('classification failures describe the confirmed stage without exposing tool diagnostics', async () => {
  const exporterFailure = wire({ HEAD: [{ status: 200, kind: 'html', contentType: 'text/html' }] })
  const unavailable = await classifyURLWith(exporterFailure.once, 'https://x.example/page', async () => { throw new Error('keychain database locked /private/tool-output') })
  assert.equal(unavailable.sessionNote, '暂时无法读取浏览器登录信息，请稍后重试。')
  assert.doesNotMatch(unavailable.sessionNote, /keychain|private|tool-output/)

  let calls = 0
  const failedRetry = await classifyURLWith(async () => {
    if (calls++ === 0) return { status: 200, kind: 'html', contentType: 'text/html', disposition: null, contentLength: null, location: null }
    throw new Error('socket implementation failure')
  }, 'https://x.example/page', async () => 'sid=fixture')
  assert.equal(failedRetry.sessionNote, '暂时无法检查此链接，请稍后重试。')
  assert.doesNotMatch(failedRetry.sessionNote, /登录|socket/)
})

test('classifyURLWith: the HEAD→GET downgrade happens inside the cookie retry too', async () => {
  // First chain: HEAD blocked, GET → html (login wall).
  // Second chain with session: HEAD blocked, GET → binary (paywalled file).
  const script = {
    HEAD: [null, null],
    GET: [{ status: 206, kind: 'html', contentType: 'text/html' }, { status: 206, kind: 'binary', contentType: 'application/zip' }]
  }
  const { once, calls } = wire(script)
  const result = await classifyURLWith(once, 'https://x.example/protected.zip', () => Promise.resolve('sid=7'))
  assert.equal(result.kind, 'binary')
  assert.equal(result.cookieUsed, 'sid=7')
  assert.deepEqual(calls.map((call) => `${call.method}@${call.url}`), [
    'HEAD@https://x.example/protected.zip',
    'GET@https://x.example/protected.zip',
    'HEAD@https://x.example/protected.zip',
    'GET@https://x.example/protected.zip'
  ])
})

test('cross-origin redirects never receive the originating Cookie header', async () => {
  const { once, calls } = wire({ HEAD: [
    { status: 302, kind: 'unknown', location: 'https://other.example/asset' },
    { status: 200, kind: 'binary', contentType: 'application/zip' }
  ] })
  const result = await probeChains({ url: 'https://private.example/asset', once, cookieHeader: 'SID=private-fixture' })
  assert.equal(calls[0].cookieHeader, 'SID=private-fixture')
  assert.equal(calls[1].cookieHeader, undefined)
  assert.equal(result.cookieUsed, undefined)
})

test('source contract: the Electron wire never downloads a probe body', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync('src/main/urlContentType.ts', 'utf8')
  // Headers-only teardown fires before any body handler could exist.
  assert.match(source, /if \(method === 'GET'\) request\.abort\(\)/)
  // Defense-in-depth body guard exists for servers that ignore Range.
  assert.match(source, /bodyBytes > MAX_PROBE_BODY_BYTES/)
  assert.match(source, /request\.abort\(\)/)
  // The 8-second timeout still bounds every request.
  assert.match(source, /timeoutMs = 8000/)
  // The rules module carries no electron import, so tests can run it.
  const rules = fs.readFileSync('src/main/urlClassificationRules.ts', 'utf8')
  assert.doesNotMatch(rules, /from 'electron'/)
})
