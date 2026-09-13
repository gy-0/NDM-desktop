import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, posix, win32 } from 'node:path'
import {
  DOWNLOAD_IMPORT_LIMITS, parseDownloadImport,
  type DownloadImportCreateReply, type DownloadImportCreateRequest, type DownloadImportEntry,
  type DownloadImportPreview, type DownloadImportPreviewReply, type DownloadImportResult, type DownloadImportStatusReply
} from '../shared/downloadImport'

export type DownloadImportCipher = {
  isEncryptionAvailable(): boolean | Promise<boolean>
  encryptString(value: string): Buffer | Promise<Buffer>
  decryptString(value: Buffer): string | Promise<string>
  getSelectedStorageBackend?(): string
}
export type DownloadImportStorage = { read(): Buffer | null | Promise<Buffer | null>; write(value: Buffer): void | Promise<void> }
export type DownloadImportDependencies = {
  statePath: string
  cipher: DownloadImportCipher
  storage?: DownloadImportStorage
  selectFile: () => Promise<string | null>
  readFile?: (path: string, maxBytes: number) => Promise<string>
  /** Both operations use the authoritative engine's durable creation receipts. */
  getCreationReceipt: (creationKey: string) => Promise<unknown>
  createDownload: (request: DownloadImportCreateRequest) => Promise<unknown>
}
type ImportRow = { id: string; creationKey: string; request?: DownloadImportCreateRequest; result?: DownloadImportResult }
type ImportSession = { id: string; sourceName: string; input: string; rows: ImportRow[]; autoStart?: boolean }
type ImportState = { version: 1; session: ImportSession | null }
type Reply = DownloadImportPreviewReply | DownloadImportCreateReply | DownloadImportStatusReply
const MAGIC = Buffer.from('NDM-IMPORT-1\n')
const MAX_STATE_BYTES = 16 * 1024 * 1024
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const unconfirmed = (id: string, error = '尚未收到任务创建确认；重试会核对同一次创建操作。'): DownloadImportResult => ({ id, status: 'unconfirmed', error })
class ImportError extends Error {}
const invalidState = (): never => { throw new ImportError('已保存的导入清单无法读取，原记录已保留。') }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidState()
  return value as Record<string, unknown>
}

function sessionPreview(session: ImportSession): DownloadImportPreview {
  const parsed = parseDownloadImport(session.input)
  for (const entry of parsed.entries) {
    if (entry.fields.folderPath) {
      const path = entry.fields.folderPath
      const absolute = process.platform === 'win32'
        ? win32.isAbsolute(path) && (/^[a-z]:[\\/]/i.test(path) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(path))
        : posix.isAbsolute(path)
      if (!absolute) entry.issues.push({ line: entry.options.find(option => option.name === 'dir')!.line, code: 'directoryPlatform', message: 'dir 不是当前系统的绝对目录，请修改后重新预览。' })
    }
  }
  return { ok: true, sessionID: session.id, sourceName: session.sourceName, ...parsed }
}

function requestFor(entry: DownloadImportEntry, creationKey: string, autoStart: boolean): DownloadImportCreateRequest {
  return { ...structuredClone(entry.fields), url: entry.uris[0], mirrors: entry.uris.slice(1), creationKey, autoStart: entry.fields.autoStart ?? autoStart }
}

function decodeState(value: unknown): ImportState {
  const source = record(value)
  if (source.version !== 1) throw new ImportError('这份导入记录来自其他版本的 NDM，原记录已保留。')
  if (source.session === null) return { version: 1, session: null }
  const data = record(source.session)
  if (typeof data.id !== 'string' || !UUID.test(data.id) || typeof data.sourceName !== 'string' || data.sourceName.length > 1024
      || typeof data.input !== 'string' || Buffer.byteLength(data.input) > DOWNLOAD_IMPORT_LIMITS.bytes || !Array.isArray(data.rows)
      || data.rows.length > DOWNLOAD_IMPORT_LIMITS.tasks || (data.autoStart !== undefined && typeof data.autoStart !== 'boolean')) return invalidState()
  const session: ImportSession = { id: data.id, sourceName: data.sourceName, input: data.input, rows: [], ...(data.autoStart === undefined ? {} : { autoStart: data.autoStart as boolean }) }
  const preview = sessionPreview(session)
  if (data.rows.length !== preview.entries.length) return invalidState()
  const keys = new Set<string>()
  session.rows = data.rows.map((value, index) => {
    const row = record(value), entry = preview.entries[index]
    if (row.id !== entry.id || typeof row.creationKey !== 'string' || !UUID.test(row.creationKey) || keys.has(row.creationKey)) return invalidState()
    keys.add(row.creationKey)
    const restored: ImportRow = { id: entry.id, creationKey: row.creationKey }
    if (row.request !== undefined) {
      const saved = record(row.request)
      if (typeof saved.autoStart !== 'boolean' || session.autoStart === undefined) return invalidState()
      const expected = requestFor(entry, row.creationKey, session.autoStart)
      // The persisted request must exactly match the original parsed input and
      // first confirmation. Never repair it by minting a new creation key.
      if (JSON.stringify(saved) !== JSON.stringify(expected)) return invalidState()
      restored.request = expected
      restored.result = unconfirmed(entry.id)
    }
    if (row.result !== undefined) {
      const result = record(row.result)
      if (result.id !== entry.id || !['accepted', 'unconfirmed', 'failed'].includes(result.status as string)) return invalidState()
      if (result.status === 'accepted') {
        if (!restored.request || !Number.isSafeInteger(result.taskID) || Number(result.taskID) < 1) return invalidState()
        restored.result = { id: entry.id, status: 'accepted', taskID: Number(result.taskID) }
      } else if (result.status === 'unconfirmed' && !restored.request) return invalidState()
      // Error strings are deliberately regenerated; engine details can contain secrets.
    }
    return restored
  })
  return { version: 1, session }
}

function fileStorage(path: string): DownloadImportStorage {
  return {
    async read() {
      let file
      try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > MAX_STATE_BYTES) return invalidState()
        const bytes = Buffer.alloc(info.size + 1)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > info.size) return invalidState()
        return bytes.subarray(0, length)
      } finally { await file.close() }
    },
    async write(bytes) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      let file
      try {
        file = await open(temporary, 'wx', 0o600)
        await file.writeFile(bytes)
        await file.sync()
        await file.close()
        file = undefined
        await rename(temporary, path)
        // POSIX also needs the containing directory durable before dispatch.
        if (process.platform !== 'win32') {
          const directory = await open(dirname(path), constants.O_RDONLY)
          try { await directory.sync() } finally { await directory.close() }
        }
      } finally { await file?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
    }
  }
}

/** A selected file is read from one handle with a hard allocation/read ceiling. */
export async function readDownloadImportFile(path: string, maxBytes = DOWNLOAD_IMPORT_LIMITS.bytes): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('请选择普通文本文件。')
    if (stat.size > maxBytes) throw new Error('任务文件不能超过 1 MiB。')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new Error('任务文件不能超过 1 MiB。')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
    catch { throw new Error('任务文件必须使用 UTF-8 编码。') }
  } finally { await file.close() }
}

export class DownloadImportService {
  private state: ImportState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly storage: DownloadImportStorage
  constructor(private readonly dependencies: DownloadImportDependencies) { this.storage = dependencies.storage ?? fileStorage(dependencies.statePath) }

  request(op: string, extra: Record<string, unknown> = {}): Promise<Reply> {
    let captured: Record<string, unknown>
    try { captured = structuredClone(extra) } catch { return Promise.reject(new ImportError('导入请求无效。')) }
    const result = this.queue.then(async () => {
      try {
        await this.ensureLoaded()
        if (op === 'downloadImportPreview') return await this.preview(captured)
        if (op === 'downloadImportCreate') return await this.create(captured)
        if (op === 'downloadImportResume') return await this.resume()
        if (op === 'downloadImportStatus') return this.snapshot()
        throw new ImportError('未知的任务导入操作。')
      } catch (error) {
        throw error instanceof ImportError ? error : new ImportError('导入操作未能完成，原清单已保留。请检查文件权限和下载引擎后重试。')
      }
    })
    this.queue = result.catch(() => undefined)
    return result
  }

  private async ensureEncryption(): Promise<void> {
    try {
      if (await this.dependencies.cipher.isEncryptionAvailable() && this.dependencies.cipher.getSelectedStorageBackend?.() !== 'basic_text') return
    } catch { /* No plaintext fallback. */ }
    throw new ImportError('系统安全存储暂不可用，导入清单尚未保存，也未提交新任务。')
  }

  private async ensureLoaded(): Promise<void> {
    await this.ensureEncryption()
    if (this.state) return
    let bytes: Buffer | null
    try { bytes = await this.storage.read() } catch { throw new ImportError('暂时无法读取已保存的导入清单，原记录已保留。') }
    if (bytes === null) { this.state = { version: 1, session: null }; return }
    if (bytes.length <= MAGIC.length || bytes.length > MAX_STATE_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return invalidState()
    let plaintext: string
    try { plaintext = await this.dependencies.cipher.decryptString(bytes.subarray(MAGIC.length)) }
    catch { throw new ImportError('暂时无法解锁已保存的导入清单，原记录已保留。') }
    if (Buffer.byteLength(plaintext) > MAX_STATE_BYTES / 2) return invalidState()
    try { this.state = decodeState(JSON.parse(plaintext)) }
    catch (error) { if (error instanceof ImportError) throw error; return invalidState() }
  }

  private async commit(session: ImportSession): Promise<void> {
    await this.ensureEncryption()
    const next: ImportState = { version: 1, session }
    const plaintext = JSON.stringify(next)
    if (Buffer.byteLength(plaintext) > MAX_STATE_BYTES / 2) throw new ImportError('导入记录超过安全存储限制，原清单已保留。')
    try {
      const bytes = Buffer.concat([MAGIC, await this.dependencies.cipher.encryptString(plaintext)])
      if (bytes.length > MAX_STATE_BYTES) throw new Error('size limit')
      await this.storage.write(bytes)
    } catch { throw new ImportError('未能安全保存导入记录，原清单已保留。请检查磁盘空间和文件权限后重试。') }
    this.state = next
  }

  private snapshot(warning?: string): DownloadImportStatusReply {
    const session = this.state!.session
    return structuredClone({ ok: true, session: session ? { preview: sessionPreview(session), input: session.input,
      results: session.rows.flatMap(row => row.result ? [row.result] : []), ...(session.autoStart === undefined ? {} : { autoStart: session.autoStart }) } : null,
      ...(warning ? { warning } : {}) })
  }

  private async preview(extra: Record<string, unknown>): Promise<DownloadImportPreviewReply> {
    if (this.state!.session?.rows.some(row => row.request && row.result?.status !== 'accepted')) {
      throw new ImportError('还有未确认的导入任务，请先恢复并核对原清单，不能用新预览替换。')
    }
    let text: string, sourceName: string
    if (extra.source === 'file') {
      const path = await this.dependencies.selectFile()
      if (path === null) return { ok: true, cancelled: true }
      try { text = await (this.dependencies.readFile ?? readDownloadImportFile)(path, DOWNLOAD_IMPORT_LIMITS.bytes) }
      catch { throw new ImportError('无法读取任务文件。请选择不超过 1 MiB 的 UTF-8 普通文本文件。') }
      sourceName = basename(path)
    } else if (extra.source === 'text' && typeof extra.text === 'string') {
      text = extra.text; sourceName = '粘贴的任务清单'
    } else throw new ImportError('请选择任务文件或粘贴清单文本。')
    if (Buffer.byteLength(text) > DOWNLOAD_IMPORT_LIMITS.bytes) throw new ImportError('清单不能超过 1 MiB；原清单已保留。')
    const session: ImportSession = { id: randomUUID(), sourceName, input: text, rows: [] }
    const preview = sessionPreview(session)
    session.rows = preview.entries.map(entry => ({ id: entry.id, creationKey: randomUUID() }))
    await this.commit(session)
    return structuredClone(preview)
  }

  private async lookup(row: ImportRow): Promise<{ result: DownloadImportResult; absent: boolean }> {
    try {
      const reply = await this.dependencies.getCreationReceipt(row.creationKey) as { ok?: boolean; receipt?: { taskID?: number } | null; pending?: boolean }
      if (reply?.ok === true && Number.isSafeInteger(reply.receipt?.taskID) && Number(reply.receipt?.taskID) > 0) {
        return { result: { id: row.id, status: 'accepted', taskID: reply.receipt!.taskID }, absent: false }
      }
      const absent = reply?.ok === true && reply.receipt === null && reply.pending !== true
      return { result: unconfirmed(row.id, absent ? '尚未查到创建回执。重试将复用已保存的原请求，不会更换任务标识。' : '引擎仍在处理或回执尚不可用，请稍后核对。'), absent }
    } catch { return { result: unconfirmed(row.id, '暂时无法查询创建回执，原请求已保留；本次未再次提交。'), absent: false } }
  }

  private async resume(): Promise<DownloadImportStatusReply> {
    const next = structuredClone(this.state!.session)
    if (!next) return this.snapshot()
    for (const row of next.rows) {
      if (row.request && row.result?.status !== 'accepted') row.result = (await this.lookup(row)).result
    }
    if (JSON.stringify(next) !== JSON.stringify(this.state!.session)) {
      try { await this.commit(next) }
      catch { return this.snapshot('回执核对结果尚未安全保存，原导入记录已保留。请稍后重试核对。') }
    }
    return this.snapshot()
  }

  private async create(extra: Record<string, unknown>): Promise<DownloadImportCreateReply> {
    const session = this.state!.session
    if (!session || extra.sessionID !== session.id) throw new ImportError('导入预览已失效，请恢复原清单。')
    const preview = sessionPreview(session)
    if (!Array.isArray(extra.itemIDs) || !extra.itemIDs.length || extra.itemIDs.length > DOWNLOAD_IMPORT_LIMITS.tasks
      || extra.itemIDs.some(id => typeof id !== 'string' || !session.rows.some(row => row.id === id)) || new Set(extra.itemIDs).size !== extra.itemIDs.length
      || typeof extra.autoStart !== 'boolean') throw new ImportError('请选择预览中的任务并确认创建方式。')
    if (preview.issues.length) throw new ImportError('清单结构有错误，请修正后重新预览。')
    const results: DownloadImportResult[] = []
    for (const id of extra.itemIDs as string[]) {
      const entry = preview.entries.find(entry => entry.id === id)!
      if (entry.issues.length) { results.push({ id, status: 'failed', error: `第 ${entry.issues[0].line} 行：${entry.issues[0].message}` }); continue }
      let next = structuredClone(this.state!.session!)
      let row = next.rows.find(row => row.id === id)!
      if (row.result?.status === 'accepted') { results.push(row.result); continue }
      if (row.request) {
        const found = await this.lookup(row)
        row.result = found.result
        try { await this.commit(next) }
        catch { results.push(unconfirmed(id, '回执核对结果尚未保存，本次未再次提交。请稍后重试。')); continue }
        if (!found.absent) { results.push(found.result); continue }
      } else {
        next.autoStart ??= extra.autoStart
        row.request = requestFor(entry, row.creationKey, next.autoStart!)
        row.result = unconfirmed(id)
        try { await this.commit(next) }
        catch { results.push({ id, status: 'failed', error: '请求未能安全保存，因此尚未发送；请检查磁盘空间和文件权限后重试。' }); continue }
      }
      // No ADD can occur before its complete immutable intent is durable.
      const result = await this.dispatch(row)
      next = structuredClone(this.state!.session!)
      row = next.rows.find(row => row.id === id)!
      row.result = result
      try { await this.commit(next); results.push(result) }
      catch { results.push(unconfirmed(id, '创建结果尚未安全保存。原请求已保留，恢复清单会核对同一次操作。')) }
    }
    return structuredClone({ ok: true, results })
  }

  private async dispatch(row: ImportRow): Promise<DownloadImportResult> {
    try {
      const reply = await this.dependencies.createDownload(structuredClone(row.request!)) as { ok?: boolean; task?: { id?: number }; receipt?: { taskID?: number } }
      const taskID = reply?.task?.id ?? reply?.receipt?.taskID
      if (reply?.ok === true && Number.isSafeInteger(taskID) && Number(taskID) > 0) return { id: row.id, status: 'accepted', taskID }
      return unconfirmed(row.id)
    } catch { return unconfirmed(row.id, '创建回执尚未收到，原请求已保留。请重试核对。') }
  }
}
