import type { ComposerDraft, ComposerDraftReply } from '../../../shared/composerDraft'

type Request = (op: string, extra?: Record<string, unknown>) => Promise<unknown>
export type DraftSessionState = { loaded: boolean; saving: boolean; error: string; draft: ComposerDraft | null }

/** A single writer in this renderer. A failed write retains the editable draft;
 * subsequent writes use the last acknowledged revision, never a guessed one. */
export class ComposerDraftSession {
  private revision = 0
  private saved = 'null'
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private state: DraftSessionState = { loaded: false, saving: false, error: '', draft: null }
  private pending = 0
  private discarded = new Set<string>()
  constructor(private request: Request) {}

  getSnapshot = (): DraftSessionState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(patch: Partial<DraftSessionState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async call(op: string, extra?: Record<string, unknown>): Promise<ComposerDraftReply> {
    const reply = await this.request(op, extra) as ComposerDraftReply
    if (!reply || typeof reply.ok !== 'boolean') throw new Error('未能读取待下载清单，请重试。')
    if (!reply.ok) throw new Error(reply.error || '清单未能保存，请重试。')
    if (!Number.isSafeInteger(reply.revision) || reply.revision < 0 || (reply.draft !== null && (!reply.draft || reply.draft.version !== 1 || !Array.isArray(reply.draft.items)))) throw new Error('未能读取待下载清单，请重试。')
    this.revision = reply.revision
    this.saved = JSON.stringify(reply.draft)
    return reply
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    this.pending++
    this.emit({ saving: true })
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined).finally(() => {
      this.pending--
      this.emit({ saving: this.pending > 0 })
    })
    return run
  }
  async load(): Promise<ComposerDraft | null> {
    if (this.state.loaded) return this.state.draft
    return this.serial(async () => {
      if (this.state.loaded) return this.state.draft
      try {
        const reply = await this.call('composerDraftLoad')
        if (!reply.ok) return null
        this.emit({ loaded: true, draft: reply.draft, error: '' })
        return reply.draft
      } catch (error) {
        this.emit({ error: error instanceof Error ? error.message : '未能读取待下载清单，请重试。' })
        throw error
      }
    })
  }
  save(draft: ComposerDraft): Promise<boolean> {
    if (this.discarded.has(draft.id)) return Promise.resolve(false)
    this.emit({ draft })
    return this.serial(async () => {
      try {
        if (!this.state.loaded) throw new Error('请先读取已保存的清单。')
        if (this.saved !== JSON.stringify(draft)) {
          const reply = await this.call('composerDraftSave', { expectedRevision: this.revision, draft })
          if (reply.ok && this.state.draft === draft) this.emit({ draft: reply.draft })
        }
        this.emit({ error: '' })
        return true
      } catch (error) {
        this.emit({ error: error instanceof Error ? error.message : '清单未能保存，请重试。' })
        return false
      }
    })
  }
  flush(): Promise<boolean> {
    const draft = this.state.draft
    return draft ? this.save(draft) : this.queue.then(() => true)
  }
  discard(): Promise<boolean> {
    const id = this.state.draft?.id
    if (id) this.discarded.add(id)
    return this.serial(async () => {
      try {
        await this.call('composerDraftDiscard', { expectedRevision: this.revision })
        this.emit({ draft: null, error: '' })
        return true
      } catch (error) {
        if (id) this.discarded.delete(id)
        this.emit({ error: error instanceof Error ? error.message : '清单未能移除，请重试。' })
        return false
      }
    })
  }
}
