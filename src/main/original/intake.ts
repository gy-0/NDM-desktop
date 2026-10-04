import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type RecordRow = { id: number; url: string; method: string }
export type OriginalSubmission = { key: string; url: string; method?: 'GET' | 'POST'; body?: string; contentType?: string }
type Receipt = { fingerprint: string; url: string; method: string; before: number[]; taskID?: number }
type Journal = { version: 1; receipts: Record<string, Receipt> }
export class OriginalIntake {
  private socket: WebSocket | undefined
  private lock: Awaited<ReturnType<typeof open>> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private lastAcknowledged = 0
  constructor(private readonly directory: string, private readonly port: number,
    private readonly records: () => Promise<RecordRow[]>, private readonly timeoutMs = 10_000) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid original bridge port')
  }

  submit(request: OriginalSubmission): Promise<number> {
    if (this.closed) return Promise.reject(new Error('Original intake closed'))
    const result = this.tail.then(() => this.send(request))
    this.tail = result.catch(() => undefined)
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    await this.tail
    this.socket?.close()
    if (this.lock) {
      await this.lock.close()
      this.lock = undefined
      await unlink(join(this.directory, 'desktop-intake.lock'))
    }
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    this.socket?.close()
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/download`, 'neatextension.v1')
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); finish(new Error('Original bridge handshake timeout')) }, this.timeoutMs)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
        if (error) reject(error); else resolve()
      }
      const opened = () => finish()
      const failed = () => finish(new Error('Original bridge handshake failed'))
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', failed)
    })
    return socket
  }

  private async load(): Promise<Journal> {
    let value: Journal
    try { value = JSON.parse(await readFile(join(this.directory, 'desktop-receipts.json'), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, receipts: {} }
      throw error
    }
    if (value.version !== 1 || !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts)) throw new Error('Invalid submission journal')
    for (const receipt of Object.values(value.receipts)) {
      if (!receipt || typeof receipt.fingerprint !== 'string' || typeof receipt.url !== 'string'
        || !['GET', 'POST'].includes(receipt.method) || !Array.isArray(receipt.before)
        || receipt.before.some(id => !Number.isSafeInteger(id) || id <= 0)
        || (receipt.taskID !== undefined && (!Number.isSafeInteger(receipt.taskID) || receipt.taskID <= 0))) throw new Error('Invalid submission receipt')
    }
    return value
  }

  private async save(journal: Journal): Promise<void> {
    const temporary = join(this.directory, `receipts-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(journal)); await file.sync() }
    finally { await file.close() }
    await rename(temporary, join(this.directory, 'desktop-receipts.json'))
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  private async send(request: OriginalSubmission): Promise<number> {
    const method = request.method ?? 'GET'
    if (typeof request.key !== 'string' || typeof request.url !== 'string'
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.key) || request.key === '__proto__'
      || !['GET', 'POST'].includes(method) || (method === 'GET' && request.body !== undefined)) throw new Error('Invalid submission')
    const url = new URL(request.url)
    if (!['http:', 'https:'].includes(url.protocol) || /[\r\n\0]/.test(request.url)
      || (request.body !== undefined && typeof request.body !== 'string')
      || (request.contentType !== undefined && (typeof request.contentType !== 'string' || /[\r\n\0]/.test(request.contentType)))) throw new Error('Invalid request fields')
    let payload = `1:${method}\r\n2:${request.url}\r\n6:normal\r\n`
    if (request.contentType) payload += `Content-Type: ${request.contentType}\r\n`
    if (request.body !== undefined) payload += '__0NeatPostData9__:' + request.body
    if (Buffer.byteLength(payload) > 60000) throw new Error('Original bridge request too large')
    if (!this.lock) this.lock = await open(join(this.directory, 'desktop-intake.lock'), 'wx', 0o600)
    const journal = await this.load()
    const fingerprint = createHash('sha256').update(JSON.stringify([request.url, method, request.body ?? null, request.contentType ?? null])).digest('hex')
    const prior = Object.hasOwn(journal.receipts, request.key) ? journal.receipts[request.key] : undefined
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Submission key reused with different content')
      if (prior.taskID !== undefined) return prior.taskID
      // A saved POST lacks proof of body identity in the original database.
      if (prior.method !== 'GET') throw new Error('POST submission outcome unknown; do not resend')
      const added = (await this.records()).filter(row => !prior.before.includes(row.id))
      if (added.length !== 1 || added[0].url !== prior.url || added[0].method !== prior.method) throw new Error('Submission outcome unknown; do not resend')
      prior.taskID = added[0].id
      await this.save(journal)
      return prior.taskID
    }
    if (Object.values(journal.receipts).some(row => row.taskID === undefined)) throw new Error('Resolve pending submission before creating another task')
    const socket = await this.connect()
    // Spacing from receipt, not send, preserves the original 500 ms intake gate.
    const spacing = this.lastAcknowledged ? Math.max(0, 550 - (performance.now() - this.lastAcknowledged))
      : Object.keys(journal.receipts).length ? 550 : 0
    await delay(spacing)
    const before = await this.records()
    const receipt: Receipt = { fingerprint, url: request.url, method, before: before.map(row => row.id) }
    journal.receipts[request.key] = receipt
    await this.save(journal)
    // Once pending is durable, every send/error/timeout is uncertain until matched.
    socket.send(payload)
    const deadline = performance.now() + this.timeoutMs
    while (performance.now() < deadline) {
      const added = (await this.records()).filter(row => !receipt.before.includes(row.id))
      if (added.length > 1) throw new Error('Ambiguous original task creation')
      if (added.length === 1) {
        if (added[0].url !== request.url || added[0].method !== method) throw new Error('Original task creation mismatch')
        receipt.taskID = added[0].id
        await this.save(journal)
        this.lastAcknowledged = performance.now()
        return receipt.taskID
      }
      await delay(50)
    }
    throw new Error('Original submission outcome unknown; reconcile before retrying')
  }
}
