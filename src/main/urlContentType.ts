import { net } from 'electron'
import {
  classify,
  classifyURLWith,
  MAX_PROBE_BODY_BYTES,
  onceRequestArgs,
  parseHeaders,
  probeChains,
  type ProbeMethod,
  type ProbeOnce,
  type ProbeRequest,
  type ProbeResult,
  type RawProbe,
  type URLKind
} from './urlClassificationRules'

// Re-exported so existing importers keep the same type surface.
export type { ProbeMethod, ProbeRequest, ProbeResult, RawProbe, URLKind }

const BODY_GUARD_INTERVAL_MS = 250

/**
 * The Electron wire for one probe request. HEAD requests never carry a body
 * handler; a ranged GET is torn down as soon as its headers are read (before
 * any `data` listener exists) and again by a body guard that destroys the
 * request once more than MAX_PROBE_BODY_BYTES has arrived — for servers that
 * ignore Range and start streaming anyway. Nothing is ever accumulated.
 */
function onceRequest(options: ProbeRequest): Promise<RawProbe> {
  const { url, cookieHeader, timeoutMs = 8000, method = 'HEAD' } = options
  const { headers } = onceRequestArgs({ url, cookieHeader, method })
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
    const request = net.request({ url, method })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    const timer = setTimeout(() => {
      request.abort()
      done(() => reject(new Error('探测超时')))
    }, timeoutMs)
    request.on('response', (response) => {
      const parsed = parseHeaders(response.headers, url, method)
      // A ranged GET must never pull the body: the transaction is aborted as
      // soon as the headers are read, before any data event handler exists.
      if (method === 'GET') request.abort()
      // Body guard for servers that ignore Range: measure what arrives past
      // the headers and cut the request the moment it exceeds the cap.
      // Nothing is accumulated — the counter only triggers the teardown.
      let bodyBytes = 0
      let bodyGuard: ReturnType<typeof setInterval> | undefined
      const stopGuard = (): void => {
        if (bodyGuard) clearInterval(bodyGuard)
      }
      if (method === 'GET') {
        bodyGuard = setInterval(() => {
          if (bodyBytes > MAX_PROBE_BODY_BYTES) {
            stopGuard()
            request.abort()
          }
        }, BODY_GUARD_INTERVAL_MS)
        response.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length
        })
      }
      const finish = (): void => {
        done(() => resolve({
          kind: classify(parsed.contentType, parsed.disposition),
          contentType: parsed.contentType,
          disposition: parsed.disposition,
          contentLength: parsed.contentLength,
          location: parsed.location,
          status: response.statusCode,
          method
        }))
      }
      // Resolve as soon as the headers are in; the guard keeps the ranged
      // GET from streaming past the cap until the transaction ends either
      // way.
      finish()
      response.once('end', stopGuard)
      response.once('error', stopGuard)
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      done(() => reject(error))
    })
    request.end()
  })
}

/** Classify a URL by asking the server what it serves (HEAD, then ranged GET). */
export async function classifyURL(
  url: string,
  cookieExporter?: (targetURL: string) => Promise<string | null>
): Promise<ProbeResult> {
  return classifyURLWith(onceRequest as ProbeOnce, url, cookieExporter)
}

/** Legacy alias: the full chain probe on the real Electron wire. */
export const probeURLKind = (options: ProbeRequest): Promise<ProbeResult> =>
  probeChains({ ...options, once: onceRequest as ProbeOnce })
