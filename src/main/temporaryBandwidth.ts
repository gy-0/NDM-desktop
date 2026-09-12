import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TemporaryBandwidthDuration, TemporaryBandwidthSnapshot } from '../shared/temporaryBandwidth'
export type { TemporaryBandwidthDuration, TemporaryBandwidthSnapshot } from '../shared/temporaryBandwidth'

type Engine = {
  readonly status: string
  request(op: string, extra?: Record<string, unknown>): Promise<unknown>
}

type Lease = {
  limitBytesPerSecond: number
  previousLimitBytesPerSecond: number
  expiresAt: number
  acknowledged: boolean
}

type Journal = { version: 1; lease: Lease | null; fallback?: Lease }

type Storage = { read(): string | null; write(contents: string): void }
type Clock = { now(): number; setTimer(callback: () => void, delay: number): unknown; clearTimer(timer: unknown): void }

export type TemporaryBandwidthOptions = {
  engine: Engine
  statePath: string
  onChange?: (snapshot: TemporaryBandwidthSnapshot) => void
  /** Small deterministic seams for fault and sleep/restart tests. */
  storage?: Storage
  clock?: Clock
  pollIntervalMs?: number
}

/** QA support overrides must isolate the recovery record as well as settings. */
export function temporaryBandwidthStatePath(userDataPath: string, supportDirectory?: string): string {
  return join(supportDirectory?.trim() || userDataPath, 'temporary-bandwidth.json')
}

function fileStorage(path: string): Storage {
  return {
    read: () => {
      try { return readFileSync(path, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    write: (contents) => {
      mkdirSync(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporaryPath, 'wx', 0o600)
        writeFileSync(descriptor, contents, 'utf8')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporaryPath, path)
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      }
    }
  }
}

const defaultClock: Clock = {
  now: Date.now,
  setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer },
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

const validLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function readLease(value: unknown): Lease {
  const record = object(value)
  if (!record || !validLimit(record.limitBytesPerSecond) || record.limitBytesPerSecond === 0 || !validLimit(record.previousLimitBytesPerSecond)
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0 || typeof record.acknowledged !== 'boolean') {
    throw new Error('临时限速记录无法读取，未更改当前限速。')
  }
  return {
    limitBytesPerSecond: record.limitBytesPerSecond,
    previousLimitBytesPerSecond: record.previousLimitBytesPerSecond,
    expiresAt: record.expiresAt as number,
    acknowledged: record.acknowledged
  }
}

/** One owner for global bandwidth writes. Route every manual updateSettings
 * through updateSettings(), including writes of the SAME limit: equal values
 * still express manual ownership and must cancel a previous restore plan.
 *
 * The current engine protocol has no revision/CAS. Comparing before a write
 * protects observed external changes, but cannot detect another process's
 * unobserved write between that read and write (or an external ABA change).
 */
export class TemporaryBandwidthController {
  private readonly storage: Storage
  private readonly clock: Clock
  private readonly pollInterval: number
  private journal: Journal = { version: 1, lease: null }
  private pendingJournalWrite = false
  private loaded = false
  private verified = false
  private error: string | undefined
  private stopped = false
  private queue: Promise<unknown> = Promise.resolve()
  private timer: unknown = null
  private lastPublished = ''

  constructor(private readonly options: TemporaryBandwidthOptions) {
    this.storage = options.storage ?? fileStorage(options.statePath)
    this.clock = options.clock ?? defaultClock
    this.pollInterval = Math.max(250, options.pollIntervalMs ?? 15_000)
  }

  getSnapshot(): TemporaryBandwidthSnapshot {
    const lease = this.journal.lease
    return {
      status: !lease ? 'inactive' : this.clock.now() >= lease.expiresAt ? 'restoring' : this.verified && lease.acknowledged ? 'active' : 'checking',
      limitBytesPerSecond: lease?.limitBytesPerSecond ?? null,
      previousLimitBytesPerSecond: lease?.previousLimitBytesPerSecond ?? null,
      expiresAt: lease?.expiresAt ?? null,
      ...(this.error ? { error: this.error } : {})
    }
  }

  /** Call once after app ready. Connection failures remain retryable state. */
  start(): Promise<TemporaryBandwidthSnapshot> { return this.reconcile() }

  /** Also call on powerMonitor.resume or a known engine reconnection. A short
   * wall-clock poll handles missing connection events and changed system time. */
  reconcile(): Promise<TemporaryBandwidthSnapshot> {
    return this.serial(async () => {
      await this.reconcileCurrent()
      return this.getSnapshot()
    }).catch((error) => {
      if (this.stopped) throw error
      return this.getSnapshot()
    })
  }

  apply(limitBytesPerSecond: number, minutes: TemporaryBandwidthDuration): Promise<TemporaryBandwidthSnapshot> {
    return this.serial(async () => {
      if (!validLimit(limitBytesPerSecond) || limitBytesPerSecond === 0 || ![15, 30, 60].includes(minutes)) {
        throw new Error('请选择有效限速和 15、30 或 60 分钟。')
      }
      const current = await this.readCurrentLimit()
      const owned = this.matchingLease(current)
      if (this.journal.lease && owned !== this.journal.lease) this.rememberVerifiedJournal({ version: 1, lease: owned })
      const lease: Lease = {
        limitBytesPerSecond,
        previousLimitBytesPerSecond: owned?.previousLimitBytesPerSecond ?? current,
        expiresAt: this.clock.now() + minutes * 60_000,
        acknowledged: false
      }
      // Extending an already acknowledged identical limit changes only its
      // deadline; no engine write or ambiguous replacement is needed.
      if (owned?.acknowledged && owned.limitBytesPerSecond === limitBytesPerSecond) {
        this.persist({ version: 1, lease: { ...lease, acknowledged: true } })
        this.verified = true
        this.error = undefined
        return this.getSnapshot()
      }
      // If replacement is interrupted before its write, the previous lease
      // still describes the limit on disk and keeps its original deadline.
      this.persist({ version: 1, lease, ...(owned ? { fallback: owned } : {}) })
      this.verified = false
      await this.writeLimit(limitBytesPerSecond)
      this.persist({ version: 1, lease: { ...lease, acknowledged: true } })
      this.verified = true
      this.error = undefined
      return this.getSnapshot()
    })
  }

  /** Manual takeover is durably disarmed BEFORE dispatch. An uncertain manual
   * write must never leave an old expiry capable of overwriting that intent.
   * On failure the caller must surface the error and can retry the same patch. */
  updateSettings(patch: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      const takesOver = Object.prototype.hasOwnProperty.call(patch, 'bandwidthLimitBytesPerSecond')
      if (takesOver && !validLimit(patch.bandwidthLimitBytesPerSecond)) throw new Error('限速必须是非负整数。')
      this.requireLive()
      if (takesOver) { this.persist({ version: 1, lease: null }); this.verified = false }
      const reply = await this.options.engine.request('updateSettings', patch)
      const body = this.requireAcknowledgement(reply)
      if (takesOver && body.settings !== undefined && object(body.settings)?.bandwidthLimitBytesPerSecond !== patch.bandwidthLimitBytesPerSecond) {
        throw new Error('引擎返回的限速与请求不符，请重试。')
      }
      this.error = undefined
      return reply
    })
  }

  /** Explicitly end the temporary period, retaining a retryable journal until
   * the original limit is confirmed restored or a different owner is seen. */
  restoreNow(): Promise<TemporaryBandwidthSnapshot> {
    return this.serial(async () => {
      if (this.journal.lease) {
        // Preserve the user's immediate-restore intent even while offline;
        // reconnect still must read and compare the actual engine value.
        const expiresAt = this.clock.now()
        this.persist({
          version: 1,
          lease: { ...this.journal.lease, expiresAt },
          ...(this.journal.fallback ? { fallback: { ...this.journal.fallback, expiresAt } } : {})
        })
        this.verified = false
        await this.reconcileCurrent()
      }
      return this.getSnapshot()
    })
  }

  /** Stop timers before engine.stop(). Await the result when the quit handler
   * can drain pending work; an abrupt exit is covered by the recovery journal. */
  stop(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    return this.queue.then(() => undefined, () => undefined)
  }

  private async reconcileCurrent(): Promise<void> {
    if (!this.journal.lease) return
    const current = await this.readCurrentLimit()
    const owned = this.matchingLease(current)
    if (!owned) {
      // Observed ownership changes are irreversible in memory even if the
      // cancellation record cannot currently reach disk. Retry that record
      // independently of the engine; never re-adopt this old lease.
      this.verified = false
      this.rememberVerifiedJournal({ version: 1, lease: null })
      this.error = undefined
      return
    }
    if (owned !== this.journal.lease) this.rememberVerifiedJournal({ version: 1, lease: owned })
    if (this.clock.now() < owned.expiresAt) {
      this.verified = owned.acknowledged
      this.error = owned.acknowledged ? undefined : '临时限速尚未确认，可重试或恢复原设置。'
      return
    }
    this.verified = false
    if (current !== owned.previousLimitBytesPerSecond) await this.writeLimit(owned.previousLimitBytesPerSecond)
    this.rememberVerifiedJournal({ version: 1, lease: null })
    this.error = undefined
  }

  private matchingLease(current: number): Lease | null {
    if (!this.journal.lease?.acknowledged && this.journal.fallback?.limitBytesPerSecond === current) return this.journal.fallback
    if (this.journal.lease?.limitBytesPerSecond === current) return this.journal.lease
    if (this.journal.fallback?.limitBytesPerSecond === current) return this.journal.fallback
    return null
  }

  private requireLive(): void {
    if (this.stopped) throw new Error('临时限速控制器已停止。')
    if (this.options.engine.status !== 'live') throw new Error('等待下载引擎连接后确认临时限速。')
  }

  private requireAcknowledgement(reply: unknown): Record<string, unknown> {
    const body = object(reply)
    if (body?.ok !== true) throw new Error('引擎未确认限速设置，请重试。')
    return body
  }

  private async readCurrentLimit(): Promise<number> {
    this.requireLive()
    const reply = this.requireAcknowledgement(await this.options.engine.request('getSettings'))
    this.requireLive()
    const current = object(reply.settings)?.bandwidthLimitBytesPerSecond
    if (!validLimit(current)) throw new Error('无法确认引擎当前限速，未更改设置。')
    return current
  }

  private async writeLimit(limit: number): Promise<void> {
    this.requireLive()
    const reply = this.requireAcknowledgement(await this.options.engine.request('updateSettings', { bandwidthLimitBytesPerSecond: limit }))
    if (reply.settings !== undefined && object(reply.settings)?.bandwidthLimitBytesPerSecond !== limit) {
      throw new Error('引擎返回的限速与请求不符，请重试。')
    }
  }

  private load(): void {
    if (this.loaded) return
    let text: string | null
    try { text = this.storage.read() }
    catch { throw new Error('临时限速记录暂时无法读取，稍后重试。') }
    this.loaded = true
    this.error = undefined
    try {
      if (text === null) return
      const parsed = object(JSON.parse(text))
      if (parsed?.version !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'lease')) throw new Error('无效记录')
      this.journal = {
        version: 1,
        lease: parsed.lease === null ? null : readLease(parsed.lease),
        ...(parsed.lease !== null && parsed.fallback !== undefined ? { fallback: readLease(parsed.fallback) } : {})
      }
    } catch { this.error = '临时限速记录无法读取，未更改当前限速。' }
  }

  private persist(journal: Journal): void {
    try { this.storage.write(JSON.stringify(journal)) }
    catch { throw new Error('无法保存临时限速恢复记录，请重试。') }
    this.journal = journal
  }

  /** Fresh observations can only narrow or end ownership. Preserve those
   * observations in memory even while their durable record needs a retry. */
  private rememberVerifiedJournal(journal: Journal): void {
    this.journal = journal
    this.pendingJournalWrite = true
    this.flushJournalWrite()
  }

  private flushJournalWrite(): void {
    if (!this.pendingJournalWrite) return
    this.persist(this.journal)
    this.pendingJournalWrite = false
    this.error = undefined
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.stopped) throw new Error('临时限速控制器已停止。')
      this.clearTimer()
      try {
        this.load()
        this.flushJournalWrite()
        return await operation()
      }
      catch (error) { this.verified = false; this.error = this.message(error); throw error }
      finally { this.publish(); this.armTimer() }
    })
    this.queue = work.catch(() => undefined)
    return work
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : '临时限速操作未完成，请重试。' }

  private publish(): void {
    const snapshot = this.getSnapshot()
    const encoded = JSON.stringify(snapshot)
    if (encoded === this.lastPublished) return
    this.lastPublished = encoded
    try { this.options.onChange?.(snapshot) } catch { /* UI observers never own recovery. */ }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer)
    this.timer = null
  }

  private armTimer(): void {
    if (this.stopped || (this.loaded && !this.journal.lease && !this.pendingJournalWrite)) return
    const remaining = this.journal.lease ? this.journal.lease.expiresAt - this.clock.now() : 0
    const delay = remaining > 0 ? Math.min(remaining, this.pollInterval) : this.pollInterval
    this.timer = this.clock.setTimer(() => {
      this.timer = null
      void this.reconcile().catch(() => undefined)
    }, delay)
  }
}
