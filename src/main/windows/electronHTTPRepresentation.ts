import { net, session } from 'electron'
import { createHash } from 'node:crypto'
import { probeHTTPRepresentation, type HTTPProbeTransport, type HTTPRepresentation } from './httpRepresentation'

const contexts = new Map<string, Promise<ReturnType<typeof session.fromPartition>>>()
function probeContext(proxy?: string): Promise<ReturnType<typeof session.fromPartition>> {
  const key = createHash('sha256').update(proxy ?? 'direct').digest('hex')
  let ready = contexts.get(key)
  if (!ready) {
    const context = session.fromPartition(`ndm-identity-${key}`)
    ready = context.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'direct' }).then(() => context)
    contexts.set(key, ready)
    void ready.catch(() => contexts.delete(key))
  }
  return ready
}

/** Isolated Chromium network context, configured exactly like the transfer proxy. */
export async function inspectHTTPRepresentation(url: string, headers: string[], proxy?: string): Promise<HTTPRepresentation | undefined> {
  const context = await probeContext(proxy)
  const once: HTTPProbeTransport = ({ url, headers, signal }) => new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', session: context, useSessionCookies: false })
    let settled = false
    const abort = (): void => finish(signal?.reason ?? new Error('下载来源检查已取消'))
    const finish = (error?: unknown, status?: number, responseHeaders?: Record<string, string | string[]>) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ status: status!, url, headers: responseHeaders! })
      request.abort()
    }
    request.on('redirect', (status, _method, location, responseHeaders) => finish(undefined, status, { ...responseHeaders, location }))
    request.on('response', response => finish(undefined, response.statusCode, response.headers))
    request.on('error', error => finish(error))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try { for (const [name, value] of Object.entries(headers)) request.setHeader(name, value); request.end() }
    catch (error) { finish(error) }
  })
  try { return await probeHTTPRepresentation(url, headers, once, AbortSignal.timeout(8000)) }
  finally { await context.clearStorageData({ storages: ['cookies'] }) }
}

/** Full transfer transport; Chromium retains certificate and configured proxy checks. */
export async function openHTTPResponse(url: string, headers: Record<string, string>, signal: AbortSignal, proxy?: string): Promise<Response> {
  const context = await probeContext(proxy)
  const response = await context.fetch(url, { method: 'GET', headers, signal, redirect: 'manual', credentials: 'omit' })
  if (response.redirected || (response.url && new URL(response.url).href !== new URL(url).href)) {
    await response.body?.cancel()
    throw new Error('下载响应发生了未验证的重定向')
  }
  // Electron's net.fetch returns an empty Response.url. Manual redirect mode
  // makes the current request URL authoritative; redirects are followed by the guard.
  if (!response.url) Object.defineProperty(response, 'url', { value: new URL(url).href })
  return response
}
