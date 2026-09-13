import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AUXILIARY_ERROR_MESSAGES, readAuxiliaryCapabilities, readAuxiliarySnapshot, validateAuxiliaryCreate } from '../shared/auxiliaryTransfer'
import type { DirectoryRulesPlatform } from '../shared/directoryRules'

type Reply = Record<string, unknown>
type Request = (op: string, extra?: Record<string, unknown>) => Promise<unknown>
type Intent = { digest: string; payload?: Reply; taskID?: number; torrentToken?: string; active?: Promise<Reply> }
const MAX_TORRENT_BYTES = 8 * 1024 * 1024
const keyPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const isObject = (value: unknown): value is Reply => !!value && typeof value === 'object' && !Array.isArray(value)
const whole = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const failure = (code = 'unavailable'): Reply => ({ ok: false, code, error: AUXILIARY_ERROR_MESSAGES[code] ?? '操作尚未确认，请重新读取任务状态。' })

/** Capture only the user-selected regular file; a later file change cannot
 * substitute different torrent bytes into an already reviewed creation intent. */
async function readTorrent(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size < 2n || before.size > BigInt(MAX_TORRENT_BYTES)) throw new Error('invalid torrent file')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (BigInt(size) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs || after.ino !== before.ino || after.dev !== before.dev
        || buffer[0] !== 100 || buffer[size - 1] !== 101) throw new Error('invalid torrent file')
    // The pinned engine validates the complete bencoded metadata. This boundary
    // only limits file access and memory; it does not claim this is a valid torrent.
    return buffer.subarray(0, size)
  } finally { await file.close() }
}

export class AuxiliaryToolsService {
  private readonly tokens = new Map<string, { data: Buffer; filename: string; createdAt: number; bound: boolean }>()
  private readonly intents = new Map<string, Intent>()
  constructor(private readonly dependencies: { request: Request; chooseTorrent: () => Promise<string | null>; platform?: DirectoryRulesPlatform; now?: () => number }) {}

  supports(op: string): boolean {
    return ['auxiliaryCapabilities', 'auxiliaryChooseTorrent', 'auxiliaryCreate', 'auxiliaryStatus', 'auxiliarySelectFiles', 'auxiliaryStopSeeding', 'auxiliaryAuthenticate'].includes(op)
  }
  async request(op: string, extra: Reply = {}): Promise<Reply> {
    try {
      if (!isObject(extra)) return failure()
      if (op === 'auxiliaryChooseTorrent') return await this.chooseTorrent()
      if (op === 'auxiliaryCreate') return await this.create(extra)
      if (op === 'auxiliaryCapabilities') {
        const capabilities = readAuxiliaryCapabilities(await this.dependencies.request(op))
        return capabilities ? { ok: true, capabilities } : failure()
      }
      if (!whole(extra.taskID, 1)) return failure('notFound')
      if (op === 'auxiliaryStatus') {
        const reply = await this.dependencies.request(op, { taskID: extra.taskID })
        const snapshot = readAuxiliarySnapshot(reply, extra.taskID)
        return snapshot ? { ok: true, snapshot } : this.safeFailure(reply)
      }
      if (!whole(extra.generation)) return failure('staleGeneration')
      const payload: Reply = { taskID: extra.taskID, generation: extra.generation }
      if (op === 'auxiliarySelectFiles') {
        if (typeof extra.autoStart !== 'boolean' || !Array.isArray(extra.indices) || !extra.indices.length || extra.indices.length > 100000
            || extra.indices.some(index => !whole(index, 1)) || new Set(extra.indices).size !== extra.indices.length) return failure('invalidSelection')
        payload.indices = [...extra.indices]; payload.autoStart = extra.autoStart
      } else if (op === 'auxiliaryAuthenticate') {
        const login = extra.credentials
        if (typeof extra.autoStart !== 'boolean' || !isObject(login) || typeof login.username !== 'string'
            || !login.username.trim() || login.username.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(login.username)
            || typeof login.password !== 'string' || !login.password.length || login.password.length > 4096 || login.password.includes('\0')) return failure('credentialsRequired')
        payload.credentials = { username: login.username, password: login.password }; payload.autoStart = extra.autoStart
      } else if (op !== 'auxiliaryStopSeeding') return failure('unsupported')
      const reply = await this.dependencies.request(op, payload)
      return isObject(reply) && reply.ok === true ? { ok: true } : this.safeFailure(reply)
    } catch { return failure() }
  }

  private safeFailure(reply: unknown): Reply {
    const code = isObject(reply) && typeof reply.code === 'string' && Object.hasOwn(AUXILIARY_ERROR_MESSAGES, reply.code)
      && reply.code !== 'invalidRequest' ? reply.code : 'unavailable'
    return failure(code)
  }

  private async chooseTorrent(): Promise<Reply> {
    const now = (this.dependencies.now ?? Date.now)()
    for (const [token, entry] of this.tokens) if (!entry.bound && now - entry.createdAt > 30 * 60 * 1000) this.tokens.delete(token)
    if (this.tokens.size >= 16) return failure('storage')
    const path = await this.dependencies.chooseTorrent()
    if (!path) return { ok: true, torrent: null }
    const filename = basename(path)
    if (!/\.torrent$/i.test(filename) || filename.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(filename)) return failure('invalidSource')
    let data: Buffer
    try { data = await readTorrent(path) } catch { return failure('invalidSource') }
    const token = randomUUID().replaceAll('-', '')
    this.tokens.set(token, { data, filename, createdAt: now, bound: false })
    return { ok: true, torrent: { token, filename } }
  }

  private async create(extra: Reply): Promise<Reply> {
    const key = typeof extra.creationKey === 'string' ? extra.creationKey : ''
    const existing = this.intents.get(key)
    let validated: ReturnType<typeof validateAuxiliaryCreate>
    try { validated = validateAuxiliaryCreate(extra, this.dependencies.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) }
    catch { return existing ? failure('receiptUnavailable') : failure('invalidRequest') }
    const digest = createHash('sha256').update(JSON.stringify(validated)).digest('hex')
    if (existing) {
      if (existing.digest !== digest) return failure('receiptUnavailable')
      if (existing.taskID) return { ok: true, taskID: existing.taskID }
      if (existing.active) return existing.active
      return this.dispatch(key, existing)
    }
    if (!keyPattern.test(key)) return failure('invalidRequest')
    // A dispatched record is never evicted: an unknown RPC outcome cannot be
    // reclassified as a safe pre-dispatch rejection after an arbitrary timeout.
    if (this.intents.size >= 512) return failure('storage')
    let source: Reply = validated.source
    if (validated.source.kind === 'torrent') {
      const selected = this.tokens.get(validated.source.token)
      if (!selected) return failure('invalidRequest')
      source = { kind: 'torrent', torrentData: selected.data.toString('base64') }
      selected.bound = true
    }
    const intent: Intent = { digest, payload: { ...validated, source }, ...(validated.source.kind === 'torrent' ? { torrentToken: validated.source.token } : {}) }
    this.intents.set(key, intent) // Must precede any asynchronous engine dispatch.
    return this.dispatch(key, intent)
  }

  private dispatch(key: string, intent: Intent): Promise<Reply> {
    const operation = (async (): Promise<Reply> => {
      try {
        // Use the single durable engine ledger before every retry. A null result
        // permits only retrying this same immutable intent and creation key.
        const receipt = await this.dependencies.request('getCreationReceipt', { creationKey: key })
        if (!isObject(receipt) || receipt.ok !== true || receipt.pending === true) return failure('receiptUnavailable')
        const known = isObject(receipt.receipt) ? receipt.receipt.taskID : undefined
        if (whole(known, 1)) return this.accept(intent, known)
        if (receipt.receipt !== null || !intent.payload) return failure('receiptUnavailable')
        const reply = await this.dependencies.request('auxiliaryCreate', structuredClone(intent.payload))
        const taskID = isObject(reply) ? reply.taskID ?? (isObject(reply.task) ? reply.task.id : undefined) ?? (isObject(reply.receipt) ? reply.receipt.taskID : undefined) : undefined
        if (isObject(reply) && reply.ok === true && whole(taskID, 1)) return this.accept(intent, taskID)
        return this.safeFailure(reply)
      } catch { return failure('receiptUnavailable') }
      finally { intent.active = undefined }
    })()
    intent.active = operation
    return operation
  }

  private accept(intent: Intent, taskID: number): Reply {
    intent.taskID = taskID
    intent.payload = undefined // Drop credentials and torrent byte copies on ACK.
    // Tokens are reusable for another task only until their first accepted intent.
    if (intent.torrentToken) this.tokens.delete(intent.torrentToken)
    return { ok: true, taskID }
  }
  dispose(): void { this.tokens.clear(); for (const intent of this.intents.values()) intent.payload = undefined }
}
