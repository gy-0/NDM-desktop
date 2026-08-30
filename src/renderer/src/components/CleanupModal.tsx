import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CirclePause, CircleX, Library, Sparkles, X } from 'lucide-react'
import { cue } from '../lib/sound'
import { removeMany, restartMany } from '../lib/store'
import { useTasks } from '../lib/useStore'
import { formatBytes } from '../lib/format'

// Keep the close timer in sync with the --modal-close-dur token in index.css.
function modalCloseMs(): number {
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')
  )
  return Number.isFinite(value) ? value : 150
}

/** Double-click confirmation kicks in above this many rows. */
const CONFIRM_ABOVE = 20

type BucketId = 'failed' | 'paused' | 'completed'

type Bucket = {
  id: BucketId
  label: string
  copy: string
  ids: number[]
  bytes: number
}

export function CleanupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useTasks()
  const [closing, setClosing] = useState(false)
  const closingTimer = useRef<number | null>(null)
  const [busy, setBusy] = useState<Record<BucketId, boolean>>({ failed: false, paused: false, completed: false })
  // Big destructive batches need a second click; the arm resets on its own.
  const [confirming, setConfirming] = useState<Record<BucketId, boolean>>({ failed: false, paused: false, completed: false })
  const confirmTimer = useRef<number | null>(null)
  const [result, setResult] = useState<{ removed: number; retried: number } | null>(null)
  const [errors, setErrors] = useState<Record<BucketId, string>>({ failed: '', paused: '', completed: '' })
  const [allBusy, setAllBusy] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const anyBusy = allBusy || Object.values(busy).some(Boolean)

  useEffect(() => {
    if (open) {
      setClosing(false)
      setBusy({ failed: false, paused: false, completed: false })
      setConfirming({ failed: false, paused: false, completed: false })
      setResult(null)
      setErrors({ failed: '', paused: '', completed: '' })
      setAllBusy(false)
      setConfirmAll(false)
    }
  }, [open])

  useEffect(
    () => () => {
      if (closingTimer.current !== null) window.clearTimeout(closingTimer.current)
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    },
    []
  )

  const handleClose = (): void => {
    if (anyBusy) return
    setClosing(true)
    if (closingTimer.current !== null) window.clearTimeout(closingTimer.current)
    closingTimer.current = window.setTimeout(() => {
      setClosing(false)
      onClose()
    }, modalCloseMs())
    cue('release')
  }

  // Capture-phase Escape so an open cleanup sheet wins over shell shortcuts,
  // mirroring how the settings drawer treats its own modal state.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, anyBusy])

  const buckets = useMemo<Bucket[]>(() => {
    const by = (pred: (task: (typeof tasks)[number]) => boolean): number[] =>
      tasks.filter(pred).map((task) => task.id)
    return [
      {
        id: 'failed' as BucketId,
        label: '失败任务',
        copy: '链接过期或站点拒绝。重试会重新开始下载；移出只清理列表，不动文件。',
        ids: by((task) => task.status === 'error'),
        bytes: tasks.filter((task) => task.status === 'error').reduce((sum, task) => sum + task.completedBytes, 0)
      },
      {
        id: 'paused' as BucketId,
        label: '已暂停任务',
        copy: '长期搁置的任务会让“继续已暂停”变得迟缓，也把列表压得很沉。',
        ids: by((task) => task.status === 'paused' || task.status === 'incomplete'),
        bytes: tasks
          .filter((task) => task.status === 'paused' || task.status === 'incomplete')
          .reduce((sum, task) => sum + task.completedBytes, 0)
      },
      {
        id: 'completed' as BucketId,
        label: '已完成记录',
        copy: '从列表移除完成记录；文件保留在原位置，随时可以再下载。',
        ids: by((task) => task.status === 'complete'),
        bytes: tasks.filter((task) => task.status === 'complete').reduce((sum, task) => sum + (task.fileSize || task.completedBytes), 0)
      }
    ]
  }, [tasks])

  const totalCleanable = buckets.reduce((sum, bucket) => sum + bucket.ids.length, 0)
  const activeCount = tasks.filter((task) => task.status === 'downloading' || task.status === 'waiting').length

  if (!open) return null

  const runBucket = async (bucket: Bucket, action: 'retry' | 'remove'): Promise<void> => {
    if (busy[bucket.id] || bucket.ids.length === 0) return
    if (
      action === 'remove' &&
      bucket.ids.length > CONFIRM_ABOVE &&
      !confirming[bucket.id]
    ) {
      setConfirming((current) => ({ ...current, [bucket.id]: true }))
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(
        () => setConfirming((current) => ({ ...current, [bucket.id]: false })),
        4000
      )
      cue('tick')
      return
    }
    setBusy((current) => ({ ...current, [bucket.id]: true }))
    setErrors((current) => ({ ...current, [bucket.id]: '' }))
    try {
      if (action === 'retry') {
        const count = await restartMany(bucket.ids)
        setResult((current) => ({
          removed: current?.removed ?? 0,
          retried: (current?.retried ?? 0) + count
        }))
        if (count !== bucket.ids.length) {
          setErrors((current) => ({
            ...current,
            [bucket.id]: `只重试了 ${count}/${bucket.ids.length} 个失败任务。请检查剩余任务后重试。`
          }))
          cue('droplet')
          return
        }
      } else {
        const count = await removeMany(bucket.ids, false)
        setResult((current) => ({
          removed: (current?.removed ?? 0) + count,
          retried: current?.retried ?? 0
        }))
      }
      cue('success')
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('只删除了 ')
        ? error.message
        : action === 'retry'
          ? '未能重试失败任务。请检查下载引擎后重试。'
          : `未能移出${bucket.label}。请检查下载引擎后重试。`
      setErrors((current) => ({ ...current, [bucket.id]: message }))
      cue('droplet')
    } finally {
      setBusy((current) => ({ ...current, [bucket.id]: false }))
      setConfirming((current) => ({ ...current, [bucket.id]: false }))
    }
  }

  const runAll = async (): Promise<void> => {
    if (anyBusy || totalCleanable === 0) return
    if (!confirmAll) {
      setConfirmAll(true)
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirmAll(false), 4000)
      cue('tick')
      return
    }

    const ids = buckets.flatMap((bucket) => bucket.ids)
    setAllBusy(true)
    setConfirmAll(false)
    setErrors({ failed: '', paused: '', completed: '' })
    try {
      const count = await removeMany(ids, false)
      setResult((current) => ({ removed: (current?.removed ?? 0) + count, retried: current?.retried ?? 0 }))
      cue('success')
    } catch {
      setErrors((current) => ({ ...current, completed: '未能完成整库整理，请分组处理后重试。' }))
      cue('droplet')
    } finally {
      setAllBusy(false)
    }
  }

  return (
    <div
      className={`t-modal-scrim absolute inset-0 z-40 grid place-items-center bg-ink/70 p-6 ${closing ? 'is-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="整理任务库"
        aria-busy={anyBusy}
        className={`t-modal max-h-full w-[min(660px,100%)] overflow-y-auto rounded-[14px] border border-line-strong bg-raised shadow-[0_18px_42px_-22px_rgb(0_0_0/0.66)] scroll-quiet ${closing ? 'is-closing' : 'is-open'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 pt-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-panel text-fog shadow-[inset_0_0_0_1px_var(--line)]">
              <Library size={18} strokeWidth={1.6} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold leading-tight tracking-[-0.015em] text-paper">任务库</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-mist">
                看清积压，再重试或移出记录；已下载文件始终保留。
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={anyBusy}
            onClick={handleClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg p-1.5 text-mist transition-colors hover:bg-line hover:text-paper disabled:cursor-wait disabled:opacity-50"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 px-6 pt-5">
          {[
            { label: '全部任务', value: tasks.length, tone: 'text-paper' },
            { label: '正在处理', value: activeCount, tone: 'text-paper' },
            { label: '需要关注', value: buckets[0]?.ids.length ?? 0, tone: buckets[0]?.ids.length ? 'text-clay' : 'text-paper' },
            { label: '可整理', value: totalCleanable, tone: 'text-paper' }
          ].map((metric) => (
            <div key={metric.label} className="rounded-[10px] bg-panel/65 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
              <div className={`font-mono text-[20px] leading-none tabular-nums ${metric.tone}`}>{metric.value}</div>
              <div className="mt-1.5 text-[10.5px] text-mist">{metric.label}</div>
            </div>
          ))}
        </div>

        {totalCleanable > 0 ? (
          <div className="mx-6 mt-3 flex items-center justify-between gap-4 rounded-[10px] border border-line bg-panel/38 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-paper">
                <Sparkles size={13} strokeWidth={1.7} />快速整理
              </div>
              <p className="mt-0.5 truncate text-[11px] text-mist">一次移出全部失败、暂停与完成记录，活动任务不受影响。</p>
            </div>
            <button
              type="button"
              disabled={anyBusy}
              onClick={() => void runAll()}
              className={`shrink-0 rounded-[8px] px-3 py-1.5 text-[11.5px] transition-colors disabled:opacity-50 ${
                confirmAll
                  ? 'bg-clay/15 font-medium text-clay shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bad)_55%,transparent)]'
                  : 'bg-paper font-medium text-ink hover:opacity-88'
              }`}
            >
              {allBusy ? '整理中…' : confirmAll ? `确认移出 ${totalCleanable} 项` : `整理 ${totalCleanable} 项`}
            </button>
          </div>
        ) : null}

        <div className="space-y-2.5 px-6 py-5">
          {totalCleanable === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-panel px-6 py-9 text-center">
              <span className="t-success-check" data-state={totalCleanable === 0 ? 'in' : undefined}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4.5 4.5L19 8" />
                </svg>
              </span>
              <p className="text-[13.5px] font-medium text-paper">任务库很干净</p>
              <p className="max-w-[300px] text-[11.5px] leading-relaxed text-mist">
                没有失败或搁置的负担。以后觉得列表沉了，随时回到这里。
              </p>
            </div>
          ) : (
            buckets.map((bucket) => {
              const Icon = bucket.id === 'failed' ? CircleX : bucket.id === 'paused' ? CirclePause : CheckCircle2
              const tone =
                bucket.id === 'failed'
                  ? { icon: 'text-clay', chip: 'bg-clay/15 text-clay' }
                  : bucket.id === 'completed'
                    ? { icon: 'text-sage', chip: 'bg-sage/15 text-sage' }
                    : { icon: 'text-fog', chip: 'bg-line text-fog' }
              return (
                <section
                  key={bucket.id}
                  aria-labelledby={`cleanup-bucket-${bucket.id}-title`}
                  className={`rounded-lg border bg-panel px-4 py-3.5 transition-opacity ${
                    bucket.ids.length === 0 ? 'border-line/60 opacity-45' : 'border-line'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Icon size={16} strokeWidth={1.8} className={`mt-0.5 shrink-0 ${tone.icon}`} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span id={`cleanup-bucket-${bucket.id}-title`} className="text-[13px] font-medium text-paper">{bucket.label}</span>
                          <span className={`rounded px-1.5 py-px text-[10.5px] tabular-nums ${tone.chip}`}>
                            {bucket.ids.length}
                          </span>
                        </div>
                        <p className="mt-1 max-w-[390px] text-[11.5px] leading-relaxed text-mist">{bucket.copy}</p>
                        {bucket.bytes > 0 ? (
                          <p className="mt-1 font-mono text-[10.5px] tabular-nums text-mist/80">
                            {bucket.id === 'completed' ? '对应文件' : '已传输'} {formatBytes(bucket.bytes)}
                          </p>
                        ) : null}
                        <p
                          id={`cleanup-bucket-${bucket.id}-status`}
                          role="status"
                          aria-live="polite"
                          className={errors[bucket.id] ? 'mt-1.5 max-w-[360px] text-[11px] leading-relaxed text-clay' : 'sr-only'}
                        >
                          {errors[bucket.id]}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {bucket.id === 'failed' && bucket.ids.length > 0 ? (
                        <button
                          type="button"
                          disabled={anyBusy}
                          aria-describedby={errors.failed ? 'cleanup-bucket-failed-status' : undefined}
                          data-cuelume-press="tick"
                          onClick={() => void runBucket(bucket, 'retry')}
                          className="rounded-lg border border-copper/50 bg-copper/10 px-2.5 py-1 text-[11.5px] font-medium text-copper transition-colors hover:bg-copper/20 disabled:opacity-50"
                        >
                          {busy.failed ? '重试中…' : '重试全部'}
                        </button>
                      ) : null}
                      {bucket.ids.length > 0 ? (
                        <button
                          type="button"
                          disabled={anyBusy}
                          aria-describedby={errors[bucket.id] ? `cleanup-bucket-${bucket.id}-status` : undefined}
                          data-cuelume-press="tick"
                          onClick={() => void runBucket(bucket, 'remove')}
                          className={`rounded-lg px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50 ${
                            confirming[bucket.id]
                              ? 'border border-clay/60 bg-clay/15 font-medium text-clay'
                              : 'border border-line text-fog hover:bg-line hover:text-paper'
                          }`}
                        >
                          {busy[bucket.id]
                            ? '处理中…'
                            : confirming[bucket.id]
                              ? `确认移出 ${bucket.ids.length} 项`
                              : '移出列表'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
              )
            })
          )}
        </div>

        <div className="relative flex min-h-[46px] items-center justify-between gap-3 border-t border-line/60 px-6 py-3">
          <p aria-live="polite" className="min-w-0 flex-1 truncate text-[11.5px] text-mist">
            {result ? (
              <span className="inline-flex items-center gap-1.5 text-paper">
                <CheckCircle2 size={13} strokeWidth={1.8} className="text-sage" />
                {result.removed > 0 ? `已移出 ${result.removed} 项` : ''}
                {result.removed > 0 && result.retried > 0 ? ' · ' : ''}
                {result.retried > 0 ? `已重试 ${result.retried} 项` : ''}
              </span>
            ) : (
              '移出不会删除已下载的文件'
            )}
          </p>
          <button
            type="button"
            disabled={anyBusy}
            onClick={handleClose}
            data-cuelume-press
            className="shrink-0 rounded-lg border border-line px-3.5 py-1 text-[12px] text-fog transition-colors hover:bg-line hover:text-paper disabled:cursor-wait disabled:opacity-50"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
