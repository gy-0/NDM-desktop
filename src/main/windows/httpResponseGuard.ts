import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
import { HTTPRepresentationError, type HTTPRepresentation, representationHeaders } from './httpRepresentation'

export type HTTPResponseTransport = (url: string, headers: Record<string, string>, signal: AbortSignal, proxy?: string) => Promise<Response>
type Route = { url: string; headers: string[]; identity: HTTPRepresentation; proxy?: string; failure?: Error; controllers: Set<AbortController> }
export type GuardedHTTPTransfer = { url: string; release(): void; failure(): Error | undefined }
const unsafe = /^(?:host|connection|proxy-authorization|proxy-connection|content-length|transfer-encoding|range|if-range|if-match|accept-encoding)$/i

export function validateGuardedResponse(response: Response, identity: HTTPRepresentation, range?: string): void {
  const fail = () => { throw new HTTPRepresentationError('下载来源在传输中发生变化，已停止写入并保留原有进度。') }
  if (createHash('sha256').update(response.url).digest('hex') !== identity.resourceHash
    || response.headers.get('etag') !== identity.etag
    || !['', 'identity'].includes((response.headers.get('content-encoding') ?? '').toLowerCase())) fail()
  const length = response.headers.get('content-length')
  if (length !== null && !/^\d+$/.test(length)) fail()
  if (response.status === 200) {
    if (range || Number(length) !== identity.totalBytes || length === null) fail()
    return
  }
  if (response.status !== 206) fail()
  const actual = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  const requested = range?.match(/^bytes=(\d+)-(\d*)$/)
  if (!actual || !requested) fail()
  const start = Number(actual![1]), end = Number(actual![2]), total = Number(actual![3])
  const wantedEnd = requested![2] ? Math.min(Number(requested![2]), identity.totalBytes - 1) : identity.totalBytes - 1
  if (![start, end, total].every(Number.isSafeInteger) || total !== identity.totalBytes
    || start !== Number(requested![1]) || end !== wantedEnd || start > end
    || (length !== null && Number(length) !== end - start + 1)) fail()
}

/** Fixed-destination loopback relay: validates headers before exposing any body byte. */
export class HTTPResponseGuard {
  private routes = new Map<string, Route>()
  private readonly server = createServer((request, response) => {
    const route = this.routes.get(request.url ?? '')
    if (!route || request.method !== 'GET' || route.failure) { response.writeHead(410).end(); return }
    const controller = new AbortController()
    route.controllers.add(controller)
    response.on('close', () => controller.abort())
    void this.forward(route, request.headers.range, response, controller.signal).catch(error => {
      if (error instanceof HTTPRepresentationError) {
        route.failure = error
        for (const pending of route.controllers) pending.abort()
      }
      if (!response.headersSent) response.writeHead(error instanceof HTTPRepresentationError ? 412 : 502).end()
      else response.destroy()
    }).finally(() => route.controllers.delete(controller))
  })
  private startup: Promise<void> | undefined
  constructor(private readonly transport: HTTPResponseTransport = async (url, headers, signal, proxy) => {
    if (proxy) throw new Error('A proxy-aware HTTP response transport is required')
    return fetch(url, { headers, signal, redirect: 'manual' })
  }) {}
  async register(url: string, headers: string[], identity: HTTPRepresentation, proxy?: string): Promise<GuardedHTTPTransfer> {
    if (!this.startup) this.startup = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.unref(); resolve() })
    })
    await this.startup
    const key = '/' + randomBytes(24).toString('hex')
    const route: Route = { url, headers, identity, proxy, controllers: new Set() }
    this.routes.set(key, route)
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Response guard unavailable')
    return { url: `http://127.0.0.1:${address.port}${key}`, failure: () => route.failure,
      release: () => { this.routes.delete(key); for (const pending of route.controllers) pending.abort() } }
  }
  close(): void {
    for (const route of this.routes.values()) for (const pending of route.controllers) pending.abort()
    this.routes.clear(); this.server.close(); this.server.closeAllConnections()
  }
  private async forward(route: Route, range: string | undefined, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (range && !/^bytes=\d+-\d*$/.test(range)) throw new HTTPRepresentationError('下载范围无效')
    let headers: Record<string, string> = { 'user-agent': 'NDM' }
    for (const line of route.headers) {
      const colon = line.indexOf(':')
      if (colon < 1 || /[\r\n]/.test(line)) throw new HTTPRepresentationError('下载请求头无效')
      const name = line.slice(0, colon).trim().toLowerCase()
      if (!unsafe.test(name)) headers[name] = line.slice(colon + 1).trim()
    }
    Object.assign(headers, representationHeaders(route.identity))
    if (range) headers.range = range
    let url = new URL(route.url), upstream: Response | undefined
    for (let hop = 0; hop < 6; hop++) {
      upstream = await this.transport(url.href, headers, signal, route.proxy)
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break
      await upstream.body?.cancel()
      const location = upstream.headers.get('location')
      if (!location) throw new HTTPRepresentationError('下载重定向无效')
      const next = new URL(location, url)
      if (!/^https?:$/.test(next.protocol) || next.username || next.password || (url.protocol === 'https:' && next.protocol !== 'https:')) throw new HTTPRepresentationError('下载重定向不安全')
      if (url.origin !== next.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => /^(?:user-agent|accept|accept-language|range|if-range|if-match|accept-encoding)$/i.test(name)))
      url = next
    }
    if (!upstream) throw new Error('No response')
    if (![200, 206].includes(upstream.status)) {
      await upstream.body?.cancel()
      if (upstream.status === 412) throw new HTTPRepresentationError('下载来源拒绝了原文件版本，已保留进度。')
      response.writeHead(upstream.status).end()
      return
    }
    try { validateGuardedResponse(upstream, route.identity, range) }
    catch (error) { await upstream.body?.cancel(); throw error }
    const output: Record<string, string> = {}
    for (const name of ['content-length', 'content-range', 'content-type', 'etag', 'accept-ranges']) {
      const value = upstream.headers.get(name); if (value !== null) output[name] = value
    }
    response.writeHead(upstream.status, output)
    const reader = upstream.body?.getReader()
    if (!reader) { response.end(); return }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!response.write(value)) await once(response, 'drain', { signal })
      }
      response.end()
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}
