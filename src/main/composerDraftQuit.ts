import { randomUUID } from 'node:crypto'

type FlushTarget = { id: number; send(token: string): void }
type Clock = { setTimer(callback: () => void, delay: number): unknown; clearTimer(timer: unknown): void }
type Options = {
  /** Return only a live main renderer; the gallery does not own the draft. */
  getTarget(): FlushTarget | null
  drain(): Promise<void>
  onReady(): void
  onCancel(): void
  timeoutMs?: number
  clock?: Clock
  token?: () => string
}

/** A quit attempt is not permission to drop unacknowledged renderer work. */
export class ComposerDraftQuitHandshake {
  private flight: Promise<boolean> | null = null
  private pending: { token: string; senderID: number; settle(ok: boolean): void } | null = null
  private confirmed = false
  private readonly clock: Clock

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? {
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  }

  get ready(): boolean { return this.confirmed }

  begin(): Promise<boolean> {
    if (this.confirmed) return Promise.resolve(true)
    if (this.flight) return this.flight
    // Install the single flight before broadcast: a synchronous send/ACK or a
    // second before-quit event must not start another attempt.
    this.flight = Promise.resolve().then(async () => {
      const target = this.options.getTarget()
      const saved = !target || await this.requestFlush(target)
      if (!saved && this.options.getTarget()) {
        this.options.onCancel()
        return false
      }
      // A destroyed/no-window renderer has no live edits left to flush. Its
      // already-received writes still finish before the engine/app shuts down.
      await this.options.drain()
      this.confirmed = true
      this.options.onReady()
      return true
    }).catch(() => {
      if (this.options.getTarget()) this.options.onCancel()
      return false
    }).finally(() => { this.flight = null })
    return this.flight
  }

  acknowledge(senderID: number, token: unknown, ok: unknown): boolean {
    if (!this.pending || typeof token !== 'string' || typeof ok !== 'boolean'
      || token !== this.pending.token || senderID !== this.pending.senderID) return false
    this.pending.settle(ok)
    return true
  }

  private requestFlush(target: FlushTarget): Promise<boolean> {
    return new Promise(resolve => {
      const token = this.options.token?.() ?? randomUUID()
      let settled = false
      let timer: unknown
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        this.clock.clearTimer(timer)
        this.pending = null
        resolve(ok)
      }
      this.pending = { token, senderID: target.id, settle }
      timer = this.clock.setTimer(() => settle(false), this.options.timeoutMs ?? 5000)
      try { target.send(token) } catch { settle(false) }
    })
  }
}
