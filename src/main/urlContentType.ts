import { net } from 'electron'

export type URLKind = 'binary' | 'html' | 'unknown'

export type ProbeResult = {
  kind: URLKind
  contentType: string
  disposition: string | null
  /** Content-Length when the server declares one, else null. */
  contentLength: number | null
  /** Cookie header that produced this classification, when one was used. */
  cookieUsed?: string
  /** Why the session retry could not run, so the UI can say what happened. */
  sessionNote?: string
}

const BINARY_TYPES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/gzip', 'application/x-gzip', 'application/x-tar',
  'application/x-7z-compressed', 'application/x-rar-compressed', 'application/vnd.rar',
  'application/pdf', 'application/octet-stream',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/epub+zip', 'application/x-mobipocket-ebook',
  'application/dmg', 'application/x-apple-diskimage',
  'application/vnd.android.package-archive'
])

function classify(contentType: string, disposition: string | null): URLKind {
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  if (disposition && /^\s*attachment/i.test(disposition)) return 'binary'
  if (BINARY_TYPES.has(normalized)) return 'binary'
  for (const prefix of ['audio/', 'video/', 'image/']) {
    if (normalized.startsWith(prefix)) return 'binary'
  }
  if (normalized === 'text/html' || normalized === 'application/xhtml+xml') return 'html'
  return 'unknown'
}

type ProbeOptions = {
  url: string
  cookieHeader?: string
  timeoutMs?: number
}

function onceRequest(options: ProbeOptions): Promise<{
  kind: URLKind
  contentType: string
  disposition: string | null
  contentLength: number | null
  location?: string
  status?: number
}> {
  const { url, cookieHeader, timeoutMs = 8000 } = options
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    // Electron's net stack shares Chromium's TLS and proxy handling, so the
    // probe behaves like the user's browser rather than like Node's strict
    // certificate chain (institutional proxies often ship partial chains).
    const request = net.request({ url, method: 'HEAD' })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh) NDM-probe')
    request.setHeader('Accept', '*/*')
    if (cookieHeader) request.setHeader('Cookie', cookieHeader)
    const timer = setTimeout(() => {
      request.abort()
      done(() => reject(new Error('探测超时')))
    }, timeoutMs)
    request.on('response', (response) => {
      const contentType = String(response.headers['content-type'] ?? '')
      const dispositionHeader = response.headers['content-disposition']
      const disposition = Array.isArray(dispositionHeader) ? dispositionHeader[0] : (dispositionHeader ?? null)
      const contentLengthHeader = response.headers['content-length']
      const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader
      const contentLength = contentLengthValue ? Number(contentLengthValue) : null
      const locationHeader = response.headers.location
      const locationValue = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
      const location = locationValue ? new URL(locationValue, url).toString() : undefined
      done(() => resolve({
        kind: classify(contentType, disposition),
        contentType,
        disposition,
        contentLength,
        location,
        status: response.statusCode
      }))
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      done(() => reject(error))
    })
    request.end()
  })
}

/** Resolve one redirect chain manually so cookies follow every hop. */
export async function probeURLKind(options: ProbeOptions): Promise<ProbeResult> {
  let current = options.url
  let cookieUsed = options.cookieHeader
  let last: { kind: URLKind; contentType: string; disposition: string | null; contentLength: number | null } | null = null
  for (let hop = 0; hop <= 4; hop++) {
    let res
    try {
      res = await onceRequest({ url: current, cookieHeader: cookieUsed, timeoutMs: options.timeoutMs })
    } catch (error) {
      if (last) return { ...last, cookieUsed }
      throw error
    }
    last = { kind: res.kind, contentType: res.contentType, disposition: res.disposition, contentLength: res.contentLength }
    if (res.kind === 'binary' || res.kind === 'html') {
      return { ...last, cookieUsed }
    }
    if (res.location && res.status && res.status >= 300 && res.status < 400) {
      current = res.location
      continue
    }
    break
  }
  if (last) return { ...last, cookieUsed }
  throw new Error('探测失败')
}

/**
 * Classify a URL by asking the server what it serves. Tries without cookies
 * first; when the server answers HTML (a login wall is the common reason) and
 * a browser cookie jar is available, retries once with the session attached —
 * a paywalled direct file then classifies as binary instead of falling into
 * media probing at all.
 */
export async function classifyURL(
  url: string,
  cookieExporter?: (targetURL: string) => Promise<string | null>
): Promise<ProbeResult> {
  const first = await probeURLKind({ url })
  if (first.kind !== 'html' || !cookieExporter) return first
  let cookieHeader: string | null = null
  try {
    cookieHeader = await cookieExporter(url)
  } catch (error) {
    return { ...first, sessionNote: error instanceof Error ? error.message : '浏览器会话读取失败' }
  }
  if (!cookieHeader) {
    return { ...first, sessionNote: '该浏览器没有与这个网站匹配的会话 Cookie' }
  }
  try {
    const second = await probeURLKind({ url, cookieHeader })
    if (second.kind === 'binary') return { ...second, cookieUsed: cookieHeader }
    // Still HTML with the session attached: the user's browser session does
    // not satisfy this wall — surface that instead of pretending all is well.
    return { ...second, sessionNote: '已尝试携带浏览器会话，网站仍然返回登录页；请在浏览器里登录后重试' }
  } catch (error) {
    return { ...first, sessionNote: error instanceof Error ? error.message : '会话重试探测失败' }
  }
}
