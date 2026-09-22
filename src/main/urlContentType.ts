import { net } from 'electron'
import {
  classify,
  classifyURLWith,
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

/** One hop on Chromium's network stack. Classification needs headers only. */
function onceRequest(options: ProbeRequest): Promise<RawProbe> {
  const { url, cookieHeader, timeoutMs = 8000, method = 'HEAD' } = options
  const { headers } = onceRequestArgs({ url, cookieHeader, method })
  return new Promise((resolve, reject) => {
    let settled = false
    const request = net.request({ url, method, redirect: 'manual' })
    const timer = setTimeout(() => finish(new Error('探测超时')), timeoutMs)
    const finish = (error: Error | null, result?: RawProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Finish before aborting: abort may synchronously emit close/error.
      if (error) reject(error)
      else resolve(result!)
      request.abort()
    }
    const answer = (rawHeaders: Record<string, string | string[]>, status: number, location?: string): void => {
      try {
        const parsed = parseHeaders(rawHeaders, url, method)
        finish(null, { ...parsed, kind: classify(parsed.contentType, parsed.disposition),
          status, method, ...(location ? { location } : {}) })
      } catch { finish(new Error('探测响应无效')) }
    }
    // Electron otherwise follows redirects before the chain policy sees them,
    // bypassing both its hop limit and explicit same-origin cookie handling.
    request.on('redirect', (status, _method, location, responseHeaders) => answer(responseHeaders, status, location))
    request.on('response', response => answer(response.headers, response.statusCode))
    request.on('error', error => finish(error))
    try {
      for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
      request.end()
    } catch { finish(new Error('探测请求无效')) }
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
