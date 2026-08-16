export type Aria2Status = {
  gid: string
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
  totalLength?: string
  completedLength?: string
  downloadSpeed?: string
  errorMessage?: string
  followedBy?: string[]
  dir?: string
  files?: Array<{ path?: string; length?: string; completedLength?: string }>
  bittorrent?: { info?: { name?: string } }
}

type RpcEnvelope<T> = {
  id: number
  jsonrpc: '2.0'
  result?: T
  error?: { code?: number; message?: string }
}

export class Aria2Rpc {
  private nextId = 1

  constructor(
    private readonly endpoint: string,
    private readonly secret: string
  ) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.nextId++
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: method.startsWith('aria2.') || method.startsWith('system.') ? method : `aria2.${method}`,
        params: [`token:${this.secret}`, ...params]
      })
    })
    if (!response.ok) throw new Error(`aria2 RPC HTTP ${response.status}`)
    const envelope = (await response.json()) as RpcEnvelope<T>
    if (envelope.error) throw new Error(envelope.error.message || `aria2 RPC ${envelope.error.code ?? 'error'}`)
    if (envelope.result === undefined) throw new Error('aria2 RPC 返回为空')
    return envelope.result
  }
}
