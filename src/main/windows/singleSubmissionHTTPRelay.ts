import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { GuardedHTTPTransfer, HTTPRequestBody, HTTPResponseTransport } from './httpResponseGuard'

type Submission = { url: string; headers: Record<string, string>; request: HTTPRequestBody; proxy?: string; claimed: boolean; controller?: AbortController; failure?: Error }
const unsafe = /^(?:host|connection|proxy-authorization|proxy-connection|content-length|transfer-encoding|range|if-range|if-match|accept-encoding)$/i

/** One initial submission per route. Downstream retries can never replay a body. */
export class SingleSubmissionHTTPRelay {
  private routes = new Map<string, Submission>()
  private startup?: Promise<void>
  private closed = false
  private readonly server = createServer((request, response) => {
    const route = this.routes.get(request.url ?? '')
    if (!route || route.claimed || request.method !== 'GET') { response.writeHead(410).end(); return }
    // aria2 may send an initial open range, but a POST response is never a
    // resumable range. Reject a suffix before consuming this submission.
    if (request.headers.range && request.headers.range !== 'bytes=0-') { response.writeHead(416).end(); return }
    route.claimed = true
    const controller = new AbortController()
    route.controller = controller
    response.on('close', () => controller.abort())
    void this.forward(route, response, controller.signal).catch(error => {
      route.failure = error instanceof Error ? error : new Error('下载提交失败')
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    })
  })

  constructor(private readonly transport: HTTPResponseTransport) {}

  async register(url: string, headers: string[], body: ArrayBuffer, proxy?: string): Promise<GuardedHTTPTransfer> {
    if (this.closed) throw new Error('下载通道已关闭')
    const target = new URL(url)
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new Error('下载地址无效')
    if (body.byteLength > 16 * 1024 * 1024) throw new Error('下载请求正文过大')
    const prepared: Record<string, string> = { 'user-agent': 'NDM', 'accept-encoding': 'identity' }
    for (const line of headers) {
      const colon = line.indexOf(':')
      if (colon < 1 || /[\r\n]/.test(line)) throw new Error('下载请求头无效')
      const name = line.slice(0, colon).trim().toLowerCase()
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error('下载请求头无效')
      if (!unsafe.test(name)) prepared[name] = line.slice(colon + 1).trim()
    }
    if (!this.startup) this.startup = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.unref(); resolve() })
    })
    await this.startup
    if (this.closed) { this.server.close(); throw new Error('下载通道已关闭') }
    const key = '/' + randomBytes(24).toString('hex')
    const route: Submission = { url: target.href, headers: prepared, request: { method: 'POST', body: body.slice(0) }, proxy, claimed: false }
    this.routes.set(key, route)
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('下载通道不可用')
    return { url: `http://127.0.0.1:${address.port}${key}`, failure: () => route.failure,
      release: () => { this.routes.delete(key); route.controller?.abort() } }
  }

  close(): void {
    this.closed = true
    for (const route of this.routes.values()) route.controller?.abort()
    this.routes.clear(); this.server.close(); this.server.closeAllConnections()
  }

  private async forward(route: Submission, response: ServerResponse, signal: AbortSignal): Promise<void> {
    let url = new URL(route.url), headers = { ...route.headers }, request: HTTPRequestBody | undefined = route.request
    let upstream: Response | undefined
    for (let hop = 0; hop < 6; hop++) {
      upstream = await this.transport(url.href, headers, signal, route.proxy, request)
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break
      await upstream.body?.cancel()
      const location = upstream.headers.get('location')
      if (!location || hop === 5) throw new Error('下载重定向无效或过多')
      const next = new URL(location, url)
      if (!/^https?:$/.test(next.protocol) || next.username || next.password || (url.protocol === 'https:' && next.protocol !== 'https:')) throw new Error('下载重定向不安全')
      if ([301, 302, 303].includes(upstream.status)) {
        request = undefined
        for (const key of Object.keys(headers)) if (/^content-/i.test(key)) delete headers[key]
      } else if (request) {
        // A preserved-body redirect is another submission. It requires a new
        // user-approved attempt instead of implicit replay (even same-origin).
        throw new Error('来源要求重新提交请求正文，请从原网页重新下载。')
      }
      if (url.origin !== next.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => /^(?:user-agent|accept|accept-language|accept-encoding)$/i.test(name)))
      url = next
    }
    if (!upstream) throw new Error('下载响应为空')
    if (upstream.status !== 200 || !['', 'identity'].includes((upstream.headers.get('content-encoding') ?? '').toLowerCase())) {
      await upstream.body?.cancel()
      throw new Error(`下载提交未返回完整文件（HTTP ${upstream.status}）`)
    }
    const length = upstream.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      await upstream.body?.cancel(); throw new Error('下载响应长度无效')
    }
    const output: Record<string, string> = { 'accept-ranges': 'none' }
    for (const name of ['content-length', 'content-type']) {
      const value = upstream.headers.get(name); if (value !== null) output[name] = value
    }
    response.writeHead(200, output)
    const reader = upstream.body?.getReader()
    let received = 0
    if (!reader) { if (Number(length) > 0) throw new Error('下载响应提前结束'); response.end(); return }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (length !== null && received > Number(length)) throw new Error('下载响应超过声明长度')
        if (!response.write(value)) await once(response, 'drain', { signal })
      }
      if (length !== null && received !== Number(length)) throw new Error('下载响应提前结束')
      response.end()
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}
