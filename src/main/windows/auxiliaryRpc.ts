export class WindowsAuxiliaryRPCError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalidResponse' | 'notFound' | 'rejected') { super(kind === 'notFound' ? '辅助任务不存在。' : '辅助引擎通信未完成。') }
}
export interface WindowsAuxiliaryRPC { call<T = unknown>(method: string, params?: unknown[]): Promise<T> }

/** Loopback-only authenticated JSON-RPC. Helper diagnostics never reach logs. */
export class WindowsAuxiliaryRPCClient implements WindowsAuxiliaryRPC {
  private nextID = 1
  constructor(private readonly endpoint: string, private readonly secret: string, private readonly timeout = 10000) {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/jsonrpc' || url.username || url.password || !secret) throw new WindowsAuxiliaryRPCError('invalidResponse')
  }
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!/^(aria2|system)\.[A-Za-z][A-Za-z\d]*$/.test(method)) throw new WindowsAuxiliaryRPCError('invalidResponse')
    const id = this.nextID++
    try {
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeout), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [`token:${this.secret}`, ...params] }) })
      // aria2 returns valid JSON-RPC errors with HTTP 400 (including absent GID).
      if (!response.body) throw new WindowsAuxiliaryRPCError('unavailable')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new WindowsAuxiliaryRPCError('invalidResponse') }
        chunks.push(value)
      }
      const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (reply?.id !== id || reply.jsonrpc !== '2.0') throw new WindowsAuxiliaryRPCError('invalidResponse')
      if (reply.error) {
        const message = typeof reply.error.message === 'string' ? reply.error.message : ''
        throw new WindowsAuxiliaryRPCError(reply.error.code === 1 && /(?:GID|gid).*not found|cannot find.*(?:GID|gid)/i.test(message) ? 'notFound' : 'rejected')
      }
      if (!response.ok || !Object.hasOwn(reply, 'result')) throw new WindowsAuxiliaryRPCError('invalidResponse')
      return reply.result as T
    } catch (error) { throw error instanceof WindowsAuxiliaryRPCError ? error : new WindowsAuxiliaryRPCError('unavailable') }
  }
}
