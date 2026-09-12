import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ComposerDraft, ComposerDraftErrorCode, ComposerDraftItem, ComposerDraftReply, ComposerDraftRequest, ComposerDraftSnapshot } from '../shared/composerDraft'

type Cipher = {
  isEncryptionAvailable(): boolean | Promise<boolean>
  encryptString(value: string): Buffer | Promise<Buffer>
  decryptString(value: Buffer): string | Promise<string>
  getSelectedStorageBackend?(): string
}
type Storage = { read(): Buffer | null; write(value: Buffer): void }
type RecordState = { version: 1; revision: number; updatedAt: number; draft: ComposerDraft | null }
export type ComposerDraftOptions = { statePath: string; cipher: Cipher; storage?: Storage; now?: () => number }

const FILE_MAGIC = Buffer.from('NDM-DRAFT-1\n')
const MAX_BYTES = 4 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const messages: Record<ComposerDraftErrorCode, string> = {
  encryptionUnavailable: '系统安全存储暂不可用，清单尚未保存。',
  encryptionFailed: '未能安全保存清单，请稍后重试。',
  decryptionFailed: '暂时无法解锁已保存的清单，原记录已保留。',
  readFailed: '暂时无法读取已保存的清单，原记录已保留。',
  writeFailed: '清单未能保存，请稍后重试。',
  corrupt: '已保存的清单无法读取，原记录已保留。',
  unsupportedVersion: '这份清单来自其他版本的 NDM，原记录已保留。',
  invalid: '清单内容无法安全保存，请检查链接与下载选项。',
  conflict: '清单已有更新，请重新打开后继续。',
  shuttingDown: 'NDM 正在退出，清单暂时无法更新。'
}
class DraftError extends Error {
  constructor(readonly code: ComposerDraftErrorCode) { super(messages[code]) }
}
const fail = (code: ComposerDraftErrorCode): never => { throw new DraftError(code) }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid')
  return value as Record<string, unknown>
}
const string = (value: unknown, max = 32768, allowEmpty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) return fail('invalid')
  return value
}
const integer = (value: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail('invalid')
  return value as number
}
const identifier = (value: unknown): string => string(value, 128)

/** Preserve signed query bytes. Credential-bearing authority strings cannot be saved. */
function safeURL(value: unknown): string {
  const text = string(value)
  try {
    const url = new URL(text)
    if (!['http:', 'https:', 'ftp:', 'magnet:'].includes(url.protocol) || url.username || url.password) return fail('invalid')
  } catch { return fail('invalid') }
  return text
}

function safeInput(value: unknown): string {
  const text = string(value, 131072, true)
  // Input is separate from the reviewed list; never normalize or silently join it.
  // Also reject pasted request headers and incomplete credential-bearing URLs.
  if (/(?:^|[\r\n])\s*(?:cookie|set-cookie|authorization|proxy-authorization)\s*:/i.test(text)
    || /(?:https?|ftp):\/\/[^\s/]*@/i.test(text)) return fail('invalid')
  return text
}

function readRequest(value: unknown): ComposerDraftRequest {
  const record = object(value)
  if (record.op !== 'add' && record.op !== 'addMedia') return fail('invalid')
  const source = object(record.options)
  const creationKey = identifier(source.creationKey)
  if (!UUID.test(creationKey)) return fail('invalid')
  const options: ComposerDraftRequest['options'] = { url: safeURL(source.url), creationKey }
  // Credentials, headers, cookies, postData and arbitrary metadata never cross this whitelist.
  if (source.folderPath !== undefined) options.folderPath = string(source.folderPath, 4096, true)
  if (source.connections !== undefined) options.connections = integer(source.connections, 0, 1024)
  if (source.filename !== undefined) options.filename = string(source.filename, 4096, true)
  if (source.autoStart !== undefined) {
    if (typeof source.autoStart !== 'boolean') return fail('invalid')
    options.autoStart = source.autoStart
  }
  if (source.cookieBrowser !== undefined) options.cookieBrowser = string(source.cookieBrowser, 128, true)
  if (source.browserSessionID !== undefined) {
    const id = string(source.browserSessionID, 36)
    if (record.op !== 'addMedia' || !UUID.test(id) || !options.cookieBrowser?.trim()) return fail('invalid')
    options.browserSessionID = id
  }
  if (source.formatID !== undefined) options.formatID = string(source.formatID, 4096, true)
  if (source.container !== undefined) options.container = string(source.container, 128, true)
  if (source.collectionScope !== undefined) {
    if (source.collectionScope !== 'current') return fail('invalid')
    options.collectionScope = 'current'
  }
  if (source.pageTitle !== undefined) options.pageTitle = string(source.pageTitle, 4096, true)
  if (source.thumbnailURL !== undefined) options.thumbnailURL = source.thumbnailURL === '' ? '' : safeURL(source.thumbnailURL)
  if (source.subtitleLanguage !== undefined) options.subtitleLanguage = string(source.subtitleLanguage, 128, true)
  return { op: record.op, options }
}

function readItem(value: unknown): ComposerDraftItem {
  const source = object(value)
  if (!['pending', 'unconfirmed', 'failed', 'accepted'].includes(source.status as string)) return fail('invalid')
  const item: ComposerDraftItem = { id: identifier(source.id), url: safeURL(source.url), status: source.status as ComposerDraftItem['status'] }
  if (source.request !== undefined) {
    item.request = readRequest(source.request)
    item.operationID = item.request.options.creationKey
    if (source.operationID !== undefined && source.operationID !== item.operationID) return fail('invalid')
    item.requestDigest = createHash('sha256').update(JSON.stringify(item.request)).digest('hex')
  } else if (source.operationID !== undefined || source.requestDigest !== undefined) return fail('invalid')
  if ((item.status === 'unconfirmed' || item.status === 'accepted') && !item.request) return fail('invalid')
  if (source.taskID !== undefined) item.taskID = integer(source.taskID, 1, Number.MAX_SAFE_INTEGER)
  if (item.status === 'accepted' ? item.taskID === undefined : item.taskID !== undefined) return fail('invalid')
  return item
}

function readDraft(value: unknown): ComposerDraft {
  const source = object(value)
  if (source.version !== 1) return fail('unsupportedVersion')
  if (!Array.isArray(source.items) || source.items.length > 1000) return fail('invalid')
  const items = source.items.map(readItem)
  if (new Set(items.map(item => item.id)).size !== items.length) return fail('invalid')
  const keys = items.flatMap(item => item.operationID ? [item.operationID] : [])
  if (new Set(keys).size !== keys.length) return fail('invalid')
  const destination = object(source.destination)
  const connections = object(source.connections)
  if (!['inherit', 'explicit'].includes(destination.mode as string) || !['inherit', 'explicit'].includes(connections.mode as string)) return fail('invalid')
  return {
    version: 1, id: identifier(source.id), input: safeInput(source.input), items,
    destination: destination.mode === 'explicit' ? { mode: 'explicit', path: string(destination.path, 4096) } : { mode: 'inherit' },
    connections: connections.mode === 'explicit' ? { mode: 'explicit', value: integer(connections.value, 1, 1024) } : { mode: 'inherit' }
  }
}

export function composerDraftStatePath(userDataPath: string, supportDirectory?: string): string {
  return join(supportDirectory?.trim() || userDataPath, 'composer-draft.enc')
}

function fileStorage(path: string): Storage {
  return {
    read() {
      try { return readFileSync(path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporary, 'wx', 0o600)
        writeFileSync(descriptor, value)
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporary, path)
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    }
  }
}

/** No engine or window references: persistence cannot create or submit downloads. */
export class ComposerDraftController {
  private readonly storage: Storage
  private state: RecordState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private closing = false

  constructor(private readonly options: ComposerDraftOptions) { this.storage = options.storage ?? fileStorage(options.statePath) }

  load(): Promise<ComposerDraftReply> { return this.run(async () => { await this.ensureLoaded(); return this.snapshot() }) }

  save(value: unknown): Promise<ComposerDraftReply> {
    // Capture caller-owned input before joining the queue so mutation cannot alter a pending write.
    let captured: unknown
    try { captured = structuredClone(value) } catch { return Promise.resolve({ ok: false, code: 'invalid', error: messages.invalid }) }
    return this.run(async () => {
      await this.ensureLoaded()
      const request = object(captured)
      this.checkRevision(request.expectedRevision)
      return this.commit(readDraft(request.draft))
    })
  }

  discard(value: unknown): Promise<ComposerDraftReply> {
    const expected = value && typeof value === 'object' ? (value as Record<string, unknown>).expectedRevision : undefined
    return this.run(async () => {
      await this.ensureLoaded()
      this.checkRevision(expected)
      // Keep a content-free encrypted tombstone. A stale save cannot revive discarded work.
      return this.commit(null)
    })
  }

  get hasPendingWrites(): boolean { return this.pending > 0 }
  async close(): Promise<void> { this.closing = true; await this.queue }

  private run(action: () => Promise<ComposerDraftSnapshot>): Promise<ComposerDraftReply> {
    if (this.closing) return Promise.resolve({ ok: false, code: 'shuttingDown', error: messages.shuttingDown })
    this.pending += 1
    const result = this.queue.then(async (): Promise<ComposerDraftReply> => {
      try { return await action() }
      catch (error) {
        const code = error instanceof DraftError ? error.code : 'invalid'
        return { ok: false, code, error: messages[code], ...(this.state ? { revision: this.state.revision } : {}) }
      }
    }).finally(() => { this.pending -= 1 })
    this.queue = result
    return result
  }

  private async ensureEncryption(): Promise<void> {
    try {
      if (!await this.options.cipher.isEncryptionAvailable() || this.options.cipher.getSelectedStorageBackend?.() === 'basic_text') return fail('encryptionUnavailable')
    } catch { return fail('encryptionUnavailable') }
  }

  private async ensureLoaded(): Promise<void> {
    await this.ensureEncryption()
    if (this.state) return
    let bytes: Buffer | null
    try { bytes = this.storage.read() } catch { return fail('readFailed') }
    if (!bytes) { this.state = { version: 1, revision: 0, updatedAt: 0, draft: null }; return }
    if (bytes.length > MAX_BYTES || bytes.length <= FILE_MAGIC.length) return fail('corrupt')
    if (!bytes.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      return fail(bytes.subarray(0, 10).toString() === 'NDM-DRAFT-' ? 'unsupportedVersion' : 'corrupt')
    }
    let plaintext: string
    try { plaintext = await this.options.cipher.decryptString(bytes.subarray(FILE_MAGIC.length)) } catch { return fail('decryptionFailed') }
    try {
      const source = object(JSON.parse(plaintext))
      if (source.version !== 1) return fail('unsupportedVersion')
      this.state = {
        version: 1, revision: integer(source.revision, 0, Number.MAX_SAFE_INTEGER - 1),
        updatedAt: integer(source.updatedAt, 0, Number.MAX_SAFE_INTEGER),
        draft: source.draft === null ? null : readDraft(source.draft)
      }
    } catch (error) { return fail(error instanceof DraftError && error.code === 'unsupportedVersion' ? 'unsupportedVersion' : 'corrupt') }
  }

  private checkRevision(value: unknown): void {
    integer(value, 0, Number.MAX_SAFE_INTEGER - 1)
    if (value !== this.state!.revision) return fail('conflict')
  }

  private async commit(draft: ComposerDraft | null): Promise<ComposerDraftSnapshot> {
    const next: RecordState = { version: 1, revision: this.state!.revision + 1, updatedAt: this.options.now?.() ?? Date.now(), draft }
    const plaintext = JSON.stringify(next)
    if (Buffer.byteLength(plaintext) > MAX_BYTES / 2) return fail('invalid')
    let bytes: Buffer
    try { bytes = Buffer.concat([FILE_MAGIC, await this.options.cipher.encryptString(plaintext)]) } catch { return fail('encryptionFailed') }
    if (bytes.length > MAX_BYTES) return fail('invalid')
    try { this.storage.write(bytes) } catch { return fail('writeFailed') }
    this.state = next
    return this.snapshot()
  }

  private snapshot(): ComposerDraftSnapshot { return { ok: true, revision: this.state!.revision, draft: structuredClone(this.state!.draft) } }
}
