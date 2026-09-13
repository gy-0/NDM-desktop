import {
  isCompletionAction, type CompletionAction, type CompletionActionErrorCode,
  type CompletionActionReply, type CompletionActionState
} from '../shared/completionAction'

export type CompletionActionTask = { id: number; status: string; isLiveRecording?: boolean }
export type CompletionActionOptions = {
  listTasks(): CompletionActionTask[] | Promise<CompletionActionTask[]>
  perform(action: CompletionAction): void | Promise<void>
  now?: () => number
  pollIntervalMs?: number
}

const messages: Record<CompletionActionErrorCode, string> = {
  invalidRequest: '请选择完成后的操作，并设置 30 到 300 秒的倒计时。',
  noPendingTasks: '当前没有等待完成的下载，请先添加或开始下载。',
  alreadyArmed: '已有一次性操作等待执行，请先取消后再修改。',
  snapshotUnavailable: '暂时无法确认下载状态，操作不会执行。请检查下载引擎后重试。',
  actionInProgress: '操作已经开始，无法再取消。',
  actionFailed: '系统未能执行该操作。请检查系统权限后重新启用，NDM 不会自动重试。',
  cancelled: '本次设置已取消。',
  shuttingDown: 'NDM 正在退出，无法启用完成后操作。'
}
class CompletionFailure extends Error {
  constructor(readonly code: CompletionActionErrorCode) { super(messages[code]) }
}
const fail = (code: CompletionActionErrorCode): never => { throw new CompletionFailure(code) }
const isFinished = (task: CompletionActionTask): boolean => task.status === 'complete' && task.isLiveRecording !== true
const off = (): CompletionActionState => ({ oneShot: true, phase: 'off', trackedTaskIDs: [], remainingTaskCount: 0 })

/** One-shot, process-local power actions. Every unknown or unfinished task blocks execution. */
export class CompletionActionService {
  private state: CompletionActionState = off()
  private readonly seen = new Set<number>()
  private readonly tracked = new Set<number>()
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private checking: Promise<void> | undefined
  private epoch = 0
  private arming = false
  private disposed = false

  constructor(private readonly options: CompletionActionOptions) {
    this.now = options.now ?? Date.now
    this.pollIntervalMs = Math.max(100, Math.min(10_000, options.pollIntervalMs ?? 1000))
  }

  async handle(op: string, extra: unknown = {}): Promise<CompletionActionReply> {
    try {
      if (op === 'completionActionStatus') await this.checkNow()
      else if (op === 'completionActionArm') await this.arm(extra)
      else if (op === 'completionActionCancel') this.cancel()
      else return fail('invalidRequest')
      return { ok: true, state: this.snapshot() }
    } catch (error) {
      const code = error instanceof CompletionFailure ? error.code : 'snapshotUnavailable'
      return { ok: false, code, error: messages[code], state: this.snapshot() }
    }
  }

  /** Also call after an engine snapshot update to interrupt a countdown immediately. */
  checkNow(): Promise<void> {
    if (this.disposed || !this.isWaiting()) return Promise.resolve()
    if (this.checking) return this.checking
    const pending = this.check()
    this.checking = pending
    void pending.finally(() => { if (this.checking === pending) this.checking = undefined })
    return pending
  }

  dispose(): void {
    this.disposed = true
    this.epoch++
    this.stopTimer()
    if (this.isWaiting() || this.arming) this.state = off()
    this.arming = false
  }

  private snapshot(): CompletionActionState {
    return { ...this.state, trackedTaskIDs: [...this.state.trackedTaskIDs] }
  }

  private isWaiting(): boolean { return this.state.phase === 'armed' || this.state.phase === 'countdown' }

  private async arm(extra: unknown): Promise<void> {
    if (this.disposed) return fail('shuttingDown')
    if (this.arming || this.isWaiting() || this.state.phase === 'executing') return fail('alreadyArmed')
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return fail('invalidRequest')
    const input = extra as Record<string, unknown>
    if (!isCompletionAction(input.action) || !Number.isInteger(input.delaySeconds)
      || (input.delaySeconds as number) < 30 || (input.delaySeconds as number) > 300) return fail('invalidRequest')
    const current = ++this.epoch
    this.arming = true
    try {
      const tasks = await this.readTasks()
      if (this.disposed || current !== this.epoch) return fail('cancelled')
      const pending = tasks.filter(task => !isFinished(task))
      if (!pending.length) return fail('noPendingTasks')
      this.seen.clear()
      this.tracked.clear()
      tasks.forEach(task => this.seen.add(task.id))
      pending.forEach(task => this.tracked.add(task.id))
      this.state = {
        oneShot: true, phase: 'armed', action: input.action, delaySeconds: input.delaySeconds as number,
        armedAt: this.now(), trackedTaskIDs: [...this.tracked], remainingTaskCount: pending.length,
        reason: 'waitingForTasks'
      }
      this.schedule()
    } finally {
      if (current === this.epoch) this.arming = false
    }
  }

  private cancel(): void {
    if (this.state.phase === 'executing') return fail('actionInProgress')
    this.epoch++
    this.arming = false
    this.stopTimer()
    this.seen.clear()
    this.tracked.clear()
    this.state = off()
  }

  private async readTasks(): Promise<CompletionActionTask[]> {
    let tasks: CompletionActionTask[]
    try { tasks = await this.options.listTasks() }
    catch { return fail('snapshotUnavailable') }
    if (!Array.isArray(tasks)) return fail('snapshotUnavailable')
    const ids = new Set<number>()
    for (const task of tasks) {
      if (!task || !Number.isSafeInteger(task.id) || task.id <= 0 || typeof task.status !== 'string'
        || !task.status || task.isLiveRecording !== undefined && typeof task.isLiveRecording !== 'boolean'
        || ids.has(task.id)) return fail('snapshotUnavailable')
      ids.add(task.id)
    }
    // Own the read: a provider mutating its cache later must not rewrite this decision.
    return tasks.map(task => ({ id: task.id, status: task.status, isLiveRecording: task.isLiveRecording }))
  }

  private applyTasks(tasks: CompletionActionTask[]): { ready: boolean; added: boolean } {
    let added = false
    for (const task of tasks) {
      // Include new tasks even if they completed between polls. A historical
      // completed task is included only if it starts another download.
      if (!this.seen.has(task.id) || !isFinished(task)) {
        if (!this.tracked.has(task.id)) { this.tracked.add(task.id); added = true }
      }
      this.seen.add(task.id)
    }
    const byID = new Map(tasks.map(task => [task.id, task]))
    let remaining = 0
    let missing = false
    for (const id of this.tracked) {
      const task = byID.get(id)
      if (!task) { missing = true; remaining++ }
      else if (!isFinished(task)) remaining++
    }
    this.state.trackedTaskIDs = [...this.tracked]
    this.state.remainingTaskCount = remaining
    const ready = this.tracked.size > 0 && remaining === 0 && tasks.every(isFinished)
    if (added || !ready) {
      this.state.phase = 'armed'
      delete this.state.countdownEndsAt
    }
    delete this.state.error
    if (!ready) this.state.reason = missing ? 'taskMissing' : 'waitingForTasks'
    else delete this.state.reason
    return { ready, added }
  }

  private async check(): Promise<void> {
    const current = this.epoch
    try {
      const tasks = await this.readTasks()
      if (this.disposed || current !== this.epoch || !this.isWaiting()) return
      const { ready } = this.applyTasks(tasks)
      if (!ready) return
      if (this.state.phase !== 'countdown') {
        this.state.phase = 'countdown'
        this.state.countdownEndsAt = this.now() + this.state.delaySeconds! * 1000
        return
      }
      if (this.now() < this.state.countdownEndsAt!) return

      // The deadline alone is not permission. Ask the engine once more just
      // before consumption, and restart the full delay if any new work appears.
      const finalTasks = await this.readTasks()
      if (this.disposed || current !== this.epoch || !this.isWaiting()) return
      const final = this.applyTasks(finalTasks)
      if (!final.ready) return
      if (final.added || this.state.phase !== 'countdown') {
        this.state.phase = 'countdown'
        this.state.countdownEndsAt = this.now() + this.state.delaySeconds! * 1000
        return
      }
      const action = this.state.action!
      // Consume the one-shot state before calling a platform adapter. Its error
      // never re-arms the action or produces an automatic second attempt.
      this.state.phase = 'executing'
      this.state.consumedAt = this.now()
      delete this.state.countdownEndsAt
      this.stopTimer()
      try {
        await this.options.perform(action)
        if (!this.disposed && current === this.epoch) this.state.phase = 'completed'
      } catch {
        if (!this.disposed && current === this.epoch) {
          this.state.phase = 'error'
          this.state.error = messages.actionFailed
        }
      }
    } catch {
      if (!this.disposed && current === this.epoch && this.isWaiting()) {
        this.state.phase = 'armed'
        this.state.reason = 'snapshotUnavailable'
        this.state.error = messages.snapshotUnavailable
        delete this.state.countdownEndsAt
      }
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    this.stopTimer()
    if (this.disposed || !this.isWaiting()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.checkNow().finally(() => this.schedule())
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }
}
