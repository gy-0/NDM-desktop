/**
 * Pure classification rules for server-driven URL probing: input
 * classification, the HEAD→GET downgrade matrix, wire-request shaping,
 * header parsing, redirect-hop routing and the chain driver. No Electron
 * imports — Node tests run the exact logic the main process runs.
 */

export type URLKind = 'binary' | 'html' | 'unknown'

export type ProbeMethod = 'HEAD' | 'GET'

export type ProbeResult = {
  kind: URLKind
  contentType: string
  disposition: string | null
  /** Content-Length when the server declares one, else null. */
  contentLength: number | null
  /** Cookie header that produced this classification, when one was used. */
  cookieUsed?: string
  /** A file-classification hint, never proof that a media page requires login. */
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

export function classify(contentType: string, disposition: string | null): URLKind {
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  if (disposition && /^\s*attachment/i.test(disposition)) return 'binary'
  if (BINARY_TYPES.has(normalized)) return 'binary'
  for (const prefix of ['audio/', 'video/', 'image/']) {
    if (normalized.startsWith(prefix)) return 'binary'
  }
  if (normalized === 'text/html' || normalized === 'application/xhtml+xml') return 'html'
  return 'unknown'
}

export type RawProbe = {
  kind: URLKind
  contentType: string
  disposition: string | null
  contentLength: number | null
  location?: string
  status?: number
  method: ProbeMethod
}

/**
 * The downgrade matrix: given what a HEAD produced, is a 1-byte ranged GET
 * on the same URL worth one more request? Some servers and gateways refuse
 * HEAD (405/501) or block the method at the network layer; both leave the
 * classification inconclusive, and the ranged GET's headers still carry the
 * real Content-Type/Disposition.
 * - No HEAD answer at all (blocked, refused, timed out) → GET.
 * - HEAD refused by the server (405/501): its headers describe the refusal,
 *   never the resource → GET, whatever they classified as.
 * - HEAD answered but classified unknown → GET.
 * - A decisive verdict (binary/html) or a redirect hop needs no GET — the
 *   redirect loop and the upstream cookie session own those.
 * - A GET is never upgraded again: one fallback per URL.
 */
export function nextProbeMethod(
  raw: Pick<RawProbe, 'kind' | 'status' | 'location'> | null,
  method: ProbeMethod = 'HEAD'
): ProbeMethod | null {
  if (method === 'GET') return null
  if (raw === null) return 'GET'
  if (raw.status === 405 || raw.status === 501) return 'GET'
  if (raw.kind === 'binary' || raw.kind === 'html') return null
  if (raw.location && raw.status !== undefined && raw.status >= 300 && raw.status < 400) return null
  return 'GET'
}

/** A 1-byte range: RFC 7233 servers answer 206; others answer 200/416. */
export const GET_PROBE_RANGE = 'bytes=0-0'

/**
 * Defense-in-depth cap for the ranged GET: a server that ignores Range and
 * streams anyway is cut off once more than this many bytes arrive. Nothing
 * is ever accumulated — the counter only triggers the teardown.
 */
export const MAX_PROBE_BODY_BYTES = 65536

/** Redirect hops allowed before the last answer becomes the verdict. */
export const MAX_PROBE_HOPS = 4

export type OnceRequestArgs = {
  url: string
  cookieHeader?: string
  method: ProbeMethod
}

/** Build the wire request for a probe; pure so tests can assert headers. */
export function onceRequestArgs(
  args: OnceRequestArgs
): { url: string; method: ProbeMethod; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh) NDM-probe',
    Accept: '*/*'
  }
  if (args.cookieHeader) headers.Cookie = args.cookieHeader
  if (args.method === 'GET') headers.Range = GET_PROBE_RANGE
  return { url: args.url, method: args.method, headers }
}

export function parseHeaders(
  rawHeaders: Record<string, string | string[] | undefined>,
  baseURL: string,
  method: ProbeMethod
): { contentType: string; disposition: string | null; contentLength: number | null; location?: string } {
  const contentType = String(rawHeaders['content-type'] ?? '')
  const dispositionHeader = rawHeaders['content-disposition']
  const disposition = Array.isArray(dispositionHeader) ? dispositionHeader[0] : (dispositionHeader ?? null)
  const lengthHeader = rawHeaders['content-length']
  const lengthValue = Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader
  // A ranged GET's Content-Length (always 1, or the 416 tail size) is not
  // the resource size, so it never travels downstream as one.
  const contentLength = method === 'GET' ? null : (lengthValue ? Number(lengthValue) : null)
  const locationHeader = rawHeaders.location
  const locationValue = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  return {
    contentType,
    disposition,
    contentLength,
    location: locationValue ? new URL(locationValue, baseURL).toString() : undefined
  }
}

/**
 * Per-hop routing: a decisive verdict returns immediately, a 3xx moves to
 * the next hop while hops remain, and anything else is the final answer.
 */
export function probeDecision(
  raw: RawProbe,
  hop: number
): { action: 'return'; result: RawProbe } | { action: 'continue'; location: string } {
  if (raw.kind === 'binary' || raw.kind === 'html') return { action: 'return', result: raw }
  if (raw.location && raw.status !== undefined && raw.status >= 300 && raw.status < 400) {
    if (hop < MAX_PROBE_HOPS) return { action: 'continue', location: raw.location }
  }
  return { action: 'return', result: raw }
}

export type ProbeRequest = {
  url: string
  cookieHeader?: string
  timeoutMs?: number
  method: ProbeMethod
}

export type ProbeOnce = (request: ProbeRequest) => Promise<RawProbe>

export type ChainOptions = {
  url: string
  once: ProbeOnce
  cookieHeader?: string
  timeoutMs?: number
}

/**
 * Resolve one redirect chain hop by hop so cookies follow every hop. Each
 * hop tries HEAD first and consults the downgrade matrix: when HEAD is
 * refused (405/501) or blocked at the network layer, the same URL is probed
 * once with a ranged GET; a refused HEAD also hands its verdict to the GET,
 * because a 405's headers describe the refusal, not the resource. A ranged
 * GET that cannot classify either never erases a HEAD answer it could not
 * beat.
 */
export async function probeChains(options: ChainOptions): Promise<ProbeResult> {
  const { url, once, timeoutMs } = options
  let current = url
  let cookieUsed = options.cookieHeader
  let last: RawProbe | null = null
  for (let hop = 0; hop <= MAX_PROBE_HOPS; hop++) {
    let res: RawProbe | null = null
    try {
      res = await once({ url: current, cookieHeader: cookieUsed, timeoutMs, method: 'HEAD' })
    } catch {
      res = null
    }
    const followup = nextProbeMethod(res, 'HEAD')
    if (followup) {
      const headRefused = res !== null && (res.status === 405 || res.status === 501)
      try {
        const ranged = await once({ url: current, cookieHeader: cookieUsed, timeoutMs, method: followup })
        if (res === null || headRefused || ranged.kind !== 'unknown') res = ranged
      } catch (error) {
        if (res === null) {
          if (last) return { ...last, cookieUsed }
          throw error
        }
      }
    }
    if (res === null) break
    last = res
    const decision = probeDecision(res, hop)
    if (decision.action === 'return') return { ...decision.result, cookieUsed }
    // A captured Cookie header has no domain/path metadata. It cannot follow
    // an arbitrary redirect to another origin; that target owns its session.
    if (new URL(current).origin !== new URL(decision.location).origin) cookieUsed = undefined
    current = decision.location
  }
  if (last) return { ...last, cookieUsed }
  throw new Error('探测失败')
}

/**
 * Classify a URL by asking its server what it serves (HEAD first, ranged
 * GET fallback per hop). Tries without cookies first; when the server
 * answers HTML (a login wall is the common reason) and a browser cookie jar
 * is available, retries once with the session attached — a paywalled direct
 * file then classifies as binary instead of falling into media probing at
 * all. The HEAD→GET fallback happens inside each attempt.
 */
export async function classifyURLWith(
  once: ProbeOnce,
  url: string,
  cookieExporter?: (targetURL: string) => Promise<string | null>
): Promise<ProbeResult> {
  const first = await probeChains({ url, once })
  if (first.kind !== 'html' || !cookieExporter) return first
  let cookieHeader: string | null = null
  try {
    cookieHeader = await cookieExporter(url)
  } catch {
    return { ...first, sessionNote: '暂时无法读取浏览器登录信息，请稍后重试。' }
  }
  if (!cookieHeader) {
    return { ...first, sessionNote: '未能识别可下载的文件。请打开来源网页确认。' }
  }
  try {
    const second = await probeChains({ url, once, cookieHeader })
    if (second.kind === 'binary') return second
    // A non-file response alone does not prove a login wall. It can also be
    // an ordinary page or a response whose type the server did not identify.
    return { ...second, sessionNote: '未能识别可下载的文件。请打开来源网页确认。' }
  } catch {
    return { ...first, sessionNote: '暂时无法检查此链接，请稍后重试。' }
  }
}
