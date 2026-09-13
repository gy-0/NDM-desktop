import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats, type ReadStream } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, normalize } from 'node:path'
import {
  isFileIntegrityAlgorithm, normalizeIntegrityDigest,
  type FileIntegrityErrorCode, type FileIntegrityJob, type FileIntegrityReply
} from '../shared/fileIntegrity'

export type FileIntegrityTask = { id: number; status: string; path: string }
export type FileIntegrityOptions = {
  resolveTask(taskID: number): FileIntegrityTask | null | Promise<FileIntegrityTask | null>
  maxConcurrent?: number
  maxJobs?: number
}
type JobRecord = { job: FileIntegrityJob; path: string; controller: AbortController; stream?: ReadStream; fingerprint?: BigIntStats }

const messages: Record<FileIntegrityErrorCode, string> = {
  invalidRequest: '校验请求无效，请重新打开任务后重试。',
  invalidExpectedDigest: '期望校验值的格式与所选算法不符，请检查位数和字符。',
  taskUnavailable: '这个下载任务已不可用，请刷新下载列表。',
  notCompleted: '文件下载完成后才能校验。',
  busy: '已有文件正在校验，请等待完成或先取消。',
  jobNotFound: '这次校验记录已过期，请重新计算。',
  fileMissing: '文件已移动或删除，请检查下载位置。',
  notRegularFile: '只能校验普通文件，不能校验文件夹、链接或设备。',
  fileChanged: '校验期间文件或下载任务发生变化，请等待文件稳定后重试。',
  readFailed: '无法读取文件，请检查文件是否可访问后重试。',
  shuttingDown: 'NDM 正在退出，请稍后重试。'
}
class IntegrityFailure extends Error {
  constructor(readonly code: FileIntegrityErrorCode) { super(messages[code]) }
}
const fail = (code: FileIntegrityErrorCode): never => { throw new IntegrityFailure(code) }
const isTaskID = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev
  && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

/** Read-only, bounded streaming work over paths supplied by the authoritative task store. */
export class FileIntegrityService {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly active = new Set<string>()
  private readonly maxConcurrent: number
  private readonly maxJobs: number
  private pendingStarts = 0
  private disposed = false

  constructor(private readonly options: FileIntegrityOptions) {
    this.maxConcurrent = Math.min(4, Math.max(1, Math.floor(options.maxConcurrent ?? 2) || 2))
    this.maxJobs = Math.min(256, Math.max(this.maxConcurrent, Math.floor(options.maxJobs ?? 32) || 32))
  }

  async handle(op: string, extra: unknown = {}): Promise<FileIntegrityReply> {
    try {
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return fail('invalidRequest')
      const input = extra as Record<string, unknown>
      if (op === 'fileIntegrityStart') return await this.start(input)
      if (op !== 'fileIntegrityStatus' && op !== 'fileIntegrityCancel') return fail('invalidRequest')
      const record = this.find(input, op === 'fileIntegrityStatus')
      if (!record) return { ok: true, job: null }
      if (op === 'fileIntegrityCancel' && this.active.has(record.job.id)) this.cancel(record)
      if (op === 'fileIntegrityStatus' && record.job.state === 'complete') await this.revalidate(record)
      return { ok: true, job: { ...record.job } }
    } catch (error) {
      const code = this.errorCode(error)
      return { ok: false, code, error: messages[code] }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.active) {
      const record = this.jobs.get(id)
      if (record) this.cancel(record)
    }
  }

  private find(input: Record<string, unknown>, allowTaskLookup: boolean): JobRecord | undefined {
    if (typeof input.jobID === 'string' && input.jobID.length <= 64 && input.jobID) {
      return this.jobs.get(input.jobID) ?? fail('jobNotFound')
    }
    if (allowTaskLookup && isTaskID(input.taskID)) {
      return [...this.jobs.values()].reverse().find(record => record.job.taskID === input.taskID)
    }
    return fail('invalidRequest')
  }

  private async start(input: Record<string, unknown>): Promise<FileIntegrityReply> {
    if (this.disposed) return fail('shuttingDown')
    if (!isTaskID(input.taskID) || !isFileIntegrityAlgorithm(input.algorithm)
      || input.expectedDigest !== undefined && typeof input.expectedDigest !== 'string'
      || ['path', 'filename', 'folderPath'].some(key => Object.hasOwn(input, key))) return fail('invalidRequest')
    const algorithm = input.algorithm
    const expected = typeof input.expectedDigest === 'string' ? input.expectedDigest.trim() : ''
    if (expected.length > 128) return fail('invalidExpectedDigest')
    const expectedDigest = expected ? normalizeIntegrityDigest(algorithm, expected) ?? fail('invalidExpectedDigest') : undefined
    const existing = [...this.active].map(id => this.jobs.get(id)!)
      .find(record => record.job.taskID === input.taskID)
    if (existing && !existing.controller.signal.aborted
      && existing.job.algorithm === algorithm && existing.job.expectedDigest === expectedDigest) {
      return { ok: true, job: { ...existing.job } }
    }
    if (existing || this.active.size + this.pendingStarts >= this.maxConcurrent) return fail('busy')
    this.pendingStarts++
    try {
      const task = await this.options.resolveTask(input.taskID)
      if (this.disposed) return fail('shuttingDown')
      this.validateTask(task, input.taskID)
      // Another start for the same task may have finished its resolver first.
      if ([...this.active].some(id => this.jobs.get(id)?.job.taskID === input.taskID)) return fail('busy')
      while (this.jobs.size >= this.maxJobs) {
        const expired = [...this.jobs.keys()].find(id => !this.active.has(id))
        if (!expired) return fail('busy')
        this.jobs.delete(expired)
      }
      const now = Date.now()
      const record: JobRecord = {
        job: { id: randomUUID(), taskID: task.id, filename: basename(task.path), algorithm,
          state: 'running', completedBytes: 0, totalBytes: 0, createdAt: now, updatedAt: now,
          ...(expectedDigest ? { expectedDigest } : {}) },
        path: task.path, controller: new AbortController()
      }
      this.jobs.set(record.job.id, record)
      this.active.add(record.job.id)
      void this.run(record, task.path)
      return { ok: true, job: { ...record.job } }
    } finally {
      this.pendingStarts--
    }
  }

  private validateTask(task: FileIntegrityTask | null, taskID: number): asserts task is FileIntegrityTask {
    if (!task || task.id !== taskID) return fail('taskUnavailable')
    if (task.status !== 'complete') return fail('notCompleted')
    if (typeof task.path !== 'string' || !task.path || task.path.includes('\0') || !isAbsolute(task.path)) return fail('taskUnavailable')
  }

  private cancel(record: JobRecord): void {
    record.controller.abort()
    record.stream?.destroy()
    record.job.state = 'cancelled'
    record.job.updatedAt = Date.now()
    delete record.job.digest
    delete record.job.matches
  }

  private async run(record: JobRecord, path: string): Promise<void> {
    let file: FileHandle | undefined
    const checkCancelled = (): void => {
      if (record.controller.signal.aborted) throw new Error('cancelled')
    }
    try {
      checkCancelled()
      const before = await lstat(path, { bigint: true })
      if (!before.isFile()) return fail('notRegularFile')
      checkCancelled()
      // O_NONBLOCK prevents a path replaced with a FIFO from hanging open();
      // O_NOFOLLOW rejects a last-component symlink swapped in after lstat().
      file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const original = await file.stat({ bigint: true })
      if (!original.isFile()) return fail('notRegularFile')
      if (!sameFile(before, original)) return fail('fileChanged')
      if (original.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('readFailed')
      record.job.totalBytes = Number(original.size)
      checkCancelled()
      const hash = createHash(record.job.algorithm)
      const stream = file.createReadStream({ highWaterMark: 256 * 1024, autoClose: false,
        start: 0, end: Math.max(0, record.job.totalBytes - 1) })
      record.stream = stream
      for await (const chunk of stream) {
        checkCancelled()
        hash.update(chunk)
        record.job.completedBytes += chunk.length
        record.job.updatedAt = Date.now()
      }
      checkCancelled()
      const task = await this.options.resolveTask(record.job.taskID)
      if (!task || task.id !== record.job.taskID || task.status !== 'complete'
        || typeof task.path !== 'string' || normalize(task.path) !== normalize(path)) return fail('fileChanged')
      checkCancelled()
      const after = await file.stat({ bigint: true })
      let current: BigIntStats
      try { current = await lstat(path, { bigint: true }) }
      catch { return fail('fileChanged') }
      if (!current.isFile() || !sameFile(original, after) || !sameFile(original, current)
        || record.job.completedBytes !== record.job.totalBytes) return fail('fileChanged')
      checkCancelled()
      record.fingerprint = current
      const digest = hash.digest('hex')
      record.job.digest = digest
      if (record.job.expectedDigest) record.job.matches = digest === record.job.expectedDigest
      record.job.state = 'complete'
    } catch (error) {
      if (record.controller.signal.aborted) record.job.state = 'cancelled'
      else {
        record.job.state = 'error'
        record.job.code = this.errorCode(error)
        record.job.error = messages[record.job.code]
      }
    } finally {
      record.stream?.destroy()
      try { await file?.close() } catch { /* A cancelled stream may already have closed its descriptor. */ }
      record.stream = undefined
      record.job.updatedAt = Date.now()
      this.active.delete(record.job.id)
    }
  }

  private async revalidate(record: JobRecord): Promise<void> {
    try {
      const task = await this.options.resolveTask(record.job.taskID)
      if (!task || task.status !== 'complete' || task.id !== record.job.taskID
        || typeof task.path !== 'string' || normalize(task.path) !== normalize(record.path)) return fail('fileChanged')
      const current = await lstat(record.path, { bigint: true })
      if (!record.fingerprint || !current.isFile() || !sameFile(record.fingerprint, current)) return fail('fileChanged')
    } catch (error) {
      record.job.state = 'error'
      record.job.code = this.errorCode(error)
      record.job.error = messages[record.job.code]
      record.job.updatedAt = Date.now()
      delete record.job.digest
      delete record.job.matches
    }
  }

  private errorCode(error: unknown): FileIntegrityErrorCode {
    if (error instanceof IntegrityFailure) return error.code
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'fileMissing'
    if (code === 'ELOOP') return 'notRegularFile'
    return 'readFailed'
  }
}
