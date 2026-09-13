import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  activeBandwidthScheduleWindow, validScheduledBandwidth, validateBandwidthScheduleRules,
  type BandwidthScheduleReply, type BandwidthScheduleRule, type BandwidthScheduleSnapshot
} from '../shared/bandwidthSchedule'

type Storage = { read(): string | null; write(contents: string): void }
type Clock = { now(): number; setTimer(callback: () => void, delay: number): unknown; clearTimer(timer: unknown): void }
export type BandwidthScheduleEngineState = { limitBytesPerSecond: number; temporaryActive: boolean }
export type BandwidthScheduleOptions = {
  statePath: string
  /** Await temporary.reconcile(), then read the authoritative engine settings and
   * temporary snapshot. Any checking/active/restoring lease means temporaryActive. */
  readState(): Promise<BandwidthScheduleEngineState>
  /** Must return an explicit {ok:true} acknowledgement. Readback is checked separately. */
  writeLimit(limitBytesPerSecond: number): Promise<unknown>
  storage?: Storage
  clock?: Clock
  pollIntervalMs?: number
}
type Lease = { baseLimit: number; limit: number; windowKey: string; acknowledged: boolean; previousLimit?: number }
type Journal = { version: 1; revision: number; enabled: boolean; rules: BandwidthScheduleRule[]; lease: Lease | null; manualWindowKey: string | null }
const empty = (): Journal => ({ version: 1, revision: 0, enabled: false, rules: [], lease: null, manualWindowKey: null })
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
class ScheduleFailure extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'storage' | 'stopped', message: string) { super(message) }
}
const defaultClock: Clock = {
  now: Date.now,
  setTimer(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer },
  clearTimer(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) }
}
function fileStorage(path: string): Storage {
  return {
    read() { try { return readFileSync(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
    write(contents) {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporary, 'wx', 0o600)
        writeFileSync(descriptor, contents, 'utf8')
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

/** A single queue coordinates rule writes and user overrides. The engine has no
 * CAS: every in-process manual or temporary mutation must use runOverride().
 * Unknown external changes relinquish ownership; an unobserved external ABA
 * change cannot be detected without an engine revision protocol. */
export class BandwidthScheduleController {
  private journal: Journal = empty()
  private readonly storage: Storage
  private readonly clock: Clock
  private readonly pollIntervalMs: number
  private queue: Promise<unknown> = Promise.resolve()
  private timer: unknown = null
  private loaded = false
  private stopped = false
  private verified = false
  private pendingWrite = false
  private status: BandwidthScheduleSnapshot['status'] = 'off'
  private error: string | undefined
  private retryKey: string | null = null
  private failures = 0
  private retryAt: number | null = null

  constructor(private readonly options: BandwidthScheduleOptions) {
    this.storage = options.storage ?? fileStorage(options.statePath)
    this.clock = options.clock ?? defaultClock
    this.pollIntervalMs = Math.max(250, Math.min(60_000, options.pollIntervalMs ?? 15_000))
  }

  getSnapshot(): BandwidthScheduleSnapshot {
    return { version: 1, revision: this.journal.revision, enabled: this.journal.enabled,
      rules: this.journal.rules.map(rule => ({ ...rule, days: [...rule.days] })), status: this.status,
      activeRule: this.window(), appliedLimitBytesPerSecond: this.verified && this.journal.lease?.acknowledged ? this.journal.lease.limit : null,
      previousLimitBytesPerSecond: this.journal.lease?.baseLimit ?? null, retryAt: this.retryAt,
      ...(this.error ? { error: this.error } : {}) }
  }

  start(): Promise<BandwidthScheduleSnapshot> { return this.reconcile() }
  reconcile(): Promise<BandwidthScheduleSnapshot> {
    return this.serial(async () => { await this.reconcileCurrent(); return this.getSnapshot() })
      .catch(() => this.getSnapshot())
  }

  async handle(op: string, extra: unknown = {}): Promise<BandwidthScheduleReply> {
    try {
      if (op === 'bandwidthScheduleStatus') return { ok: true, state: await this.reconcile() }
      if (op !== 'bandwidthScheduleSave') throw new ScheduleFailure('invalid', '周期限速请求无效。')
      const state = await this.serial(async () => {
        const input = object(extra)
        if (!input || !Number.isSafeInteger(input.expectedRevision) || typeof input.enabled !== 'boolean') throw new ScheduleFailure('invalid', '规则设置无效，请重新检查。')
        if (input.expectedRevision !== this.journal.revision) throw new ScheduleFailure('conflict', '规则已有更新，请重新读取后再保存。')
        let rules: BandwidthScheduleRule[]
        try { rules = validateBandwidthScheduleRules(input.rules) }
        catch (error) { throw new ScheduleFailure('invalid', error instanceof Error ? error.message : '规则设置无效。') }
        if (input.enabled && !rules.some(rule => rule.enabled)) throw new ScheduleFailure('invalid', '请先添加并启用至少一条规则。')
        this.persist({ ...this.journal, revision: this.journal.revision + 1, enabled: input.enabled,
          rules, manualWindowKey: null })
        this.resetRetry()
        await this.reconcileCurrent()
        return this.getSnapshot()
      })
      return { ok: true, state }
    } catch (error) {
      const failure = error instanceof ScheduleFailure ? error : new ScheduleFailure('storage', '规则暂时无法保存，请重试。')
      return { ok: false, code: failure.code, error: failure.message, state: this.getSnapshot() }
    }
  }

  /** Wrap EVERY manual bandwidth write, including the same value, and each user
   * temporary start/restore. The queued operation may call TemporaryBandwidthController;
   * readState must call temporary.reconcile directly, never recursively enter this queue. */
  runOverride<T>(kind: 'manual' | 'temporary', operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (kind === 'manual') {
        // Disarm recovery before dispatch, even if the user's RPC later fails.
        this.persist({ ...this.journal, lease: null, manualWindowKey: this.window()?.windowKey ?? null })
        this.status = this.window() ? 'overridden' : this.journal.enabled ? 'idle' : 'off'
      } else this.status = 'temporary'
      this.verified = false
      this.resetRetry()
      return operation()
    })
  }

  stop(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    return this.queue.then(() => undefined, () => undefined)
  }

  private window() {
    return this.journal.enabled ? activeBandwidthScheduleWindow(this.journal.rules, new Date(this.clock.now())) : null
  }
  private requireLive(): void { if (this.stopped) throw new ScheduleFailure('stopped', '周期限速控制器已停止。') }

  private async readState(): Promise<BandwidthScheduleEngineState> {
    this.requireLive()
    const state = await this.options.readState()
    this.requireLive()
    if (!state || !validScheduledBandwidth(state.limitBytesPerSecond) || typeof state.temporaryActive !== 'boolean') throw new Error('无法确认当前限速，未修改设置。')
    return state
  }

  private async reconcileCurrent(): Promise<void> {
    // A slow engine reply can cross a minute boundary or span sleep. Correct
    // that now rather than publishing an already-expired rule until the next poll.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = this.window()?.windowKey ?? null
      await this.reconcileOnce()
      if (before === (this.window()?.windowKey ?? null)) return
    }
    // Bound work if the wall clock keeps jumping while requests are in flight.
    this.verified = false
    this.status = this.window() ? 'applying' : this.journal.lease ? 'restoring' : this.journal.enabled ? 'idle' : 'off'
    this.retryAt = this.clock.now() + 25
  }

  private async reconcileOnce(): Promise<void> {
    let desired = this.window()
    const key = desired ? `${desired.windowKey}:${desired.limitBytesPerSecond}` : `restore:${this.journal.lease?.windowKey ?? 'none'}`
    if (key !== this.retryKey) { this.resetRetry(); this.retryKey = key }
    if (this.retryAt !== null && this.clock.now() < this.retryAt) return
    try {
      if (this.journal.manualWindowKey && this.journal.manualWindowKey !== desired?.windowKey) {
        this.remember({ ...this.journal, manualWindowKey: null })
      }
      if (this.pendingWrite) this.flushWrite()
      if (desired && this.journal.manualWindowKey === desired.windowKey && !this.journal.lease) {
        this.status = 'overridden'; this.error = undefined; return
      }
      if (!desired && !this.journal.lease) {
        this.status = this.journal.enabled ? 'idle' : 'off'; this.verified = false; this.error = undefined; return
      }
      const state = await this.readState()
      // Temporary reconciliation can consume time or resume after sleep; choose
      // the current wall-clock window again before deciding on any write.
      desired = this.window()
      if (state.temporaryActive) { this.status = 'temporary'; this.verified = false; this.error = undefined; this.resetRetry(); return }
      const lease = this.journal.lease
      if (lease && state.limitBytesPerSecond !== lease.limit
        && (lease.acknowledged || state.limitBytesPerSecond !== lease.previousLimit)) {
        // Observed external ownership wins, even if persisting the cancellation fails.
        this.verified = false
        this.remember({ ...this.journal, lease: null, manualWindowKey: desired?.windowKey ?? null })
        this.status = desired ? 'overridden' : this.journal.enabled ? 'idle' : 'off'
        this.error = undefined
        return
      }
      if (!desired) {
        if (!lease) { this.status = this.journal.enabled ? 'idle' : 'off'; this.error = undefined; return }
        this.status = 'restoring'
        this.verified = false
        if (state.limitBytesPerSecond !== lease.baseLimit) await this.writeAndVerify(lease.baseLimit)
        this.remember({ ...this.journal, lease: null })
        this.status = this.journal.enabled ? 'idle' : 'off'
        this.error = undefined
        this.resetRetry()
        return
      }
      if (this.journal.manualWindowKey === desired.windowKey) { this.status = 'overridden'; this.verified = false; return }
      if (lease?.acknowledged && lease.limit === desired.limitBytesPerSecond && state.limitBytesPerSecond === lease.limit) {
        if (lease.windowKey !== desired.windowKey) this.persist({ ...this.journal, lease: { ...lease, windowKey: desired.windowKey } })
        this.status = 'scheduled'; this.verified = true; this.error = undefined; this.resetRetry(); return
      }
      const intent: Lease = { baseLimit: lease?.baseLimit ?? state.limitBytesPerSecond,
        limit: desired.limitBytesPerSecond, windowKey: desired.windowKey, acknowledged: false,
        previousLimit: state.limitBytesPerSecond }
      // Persist a recoverable intent before the RPC. Failed ACKs do not count as
      // applied and must retry in this very same window after bounded backoff.
      this.persist({ ...this.journal, lease: intent })
      this.status = 'applying'
      this.verified = false
      await this.writeAndVerify(intent.limit)
      this.persist({ ...this.journal, lease: { ...intent, acknowledged: true } })
      this.status = 'scheduled'
      this.verified = true
      this.error = undefined
      this.resetRetry()
    } catch (error) {
      this.verified = false
      this.status = 'error'
      this.error = error instanceof Error ? error.message : '周期限速未确认，将自动重试。'
      this.failures++
      this.retryAt = this.clock.now() + Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures - 1))
    }
  }

  private async writeAndVerify(limit: number): Promise<void> {
    this.requireLive()
    const reply = object(await this.options.writeLimit(limit))
    this.requireLive()
    if (reply?.ok !== true) throw new Error('引擎尚未确认规则限速，将自动重试。')
    const state = await this.readState()
    if (state.temporaryActive || state.limitBytesPerSecond !== limit) throw new Error('限速回读与规则不一致，将重新检查。')
  }

  private resetRetry(): void { this.failures = 0; this.retryAt = null }
  private persist(journal: Journal): void {
    try { this.storage.write(JSON.stringify(journal)) }
    catch { throw new ScheduleFailure('storage', '无法保存周期限速记录，未继续修改限速。') }
    this.journal = journal
    this.pendingWrite = false
  }
  private remember(journal: Journal): void {
    this.journal = journal
    this.pendingWrite = true
    this.flushWrite()
  }
  private flushWrite(): void { if (this.pendingWrite) this.persist(this.journal) }

  private load(): void {
    if (this.loaded) return
    let text: string | null
    try { text = this.storage.read() }
    catch { throw new ScheduleFailure('storage', '周期限速规则暂时无法读取，未修改限速。') }
    if (text === null) { this.loaded = true; return }
    try {
      const source = object(JSON.parse(text))
      if (source?.version !== 1 || !Number.isSafeInteger(source.revision) || (source.revision as number) < 0
        || typeof source.enabled !== 'boolean' || !(source.manualWindowKey === null || typeof source.manualWindowKey === 'string')) throw new Error('invalid')
      const rules = validateBandwidthScheduleRules(source.rules)
      let lease: Lease | null = null
      if (source.lease !== null) {
        const value = object(source.lease)
        if (!value || !validScheduledBandwidth(value.baseLimit) || !validScheduledBandwidth(value.limit)
          || typeof value.windowKey !== 'string' || !value.windowKey || typeof value.acknowledged !== 'boolean'
          || value.previousLimit !== undefined && !validScheduledBandwidth(value.previousLimit)) throw new Error('invalid')
        lease = { baseLimit: value.baseLimit, limit: value.limit, windowKey: value.windowKey, acknowledged: value.acknowledged,
          ...(value.previousLimit !== undefined ? { previousLimit: value.previousLimit as number } : {}) }
      }
      this.journal = { version: 1, revision: source.revision as number, enabled: source.enabled, rules, lease,
        manualWindowKey: source.manualWindowKey as string | null }
      this.loaded = true
    } catch { throw new ScheduleFailure('storage', '周期限速记录损坏或版本不兼容，未修改当前限速。') }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      this.requireLive()
      this.clearTimer()
      try { this.load(); return await operation() }
      catch (error) { this.verified = false; this.status = 'error'; this.error = error instanceof Error ? error.message : '周期限速操作未完成。'; throw error }
      finally { this.schedule() }
    })
    this.queue = pending.catch(() => undefined)
    return pending
  }
  private clearTimer(): void { if (this.timer !== null) this.clock.clearTimer(this.timer); this.timer = null }
  private schedule(): void {
    this.clearTimer()
    if (this.stopped || this.loaded && !this.journal.enabled && !this.journal.lease && !this.pendingWrite) return
    const date = new Date(this.clock.now())
    const toMinute = 60_000 - date.getSeconds() * 1000 - date.getMilliseconds()
    const toRetry = this.retryAt === null ? this.pollIntervalMs : Math.max(25, this.retryAt - this.clock.now())
    const delay = Math.max(25, Math.min(this.pollIntervalMs, toMinute, toRetry))
    this.timer = this.clock.setTimer(() => { this.timer = null; void this.reconcile() }, delay)
  }
}
