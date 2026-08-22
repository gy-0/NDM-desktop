import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CirclePause, CircleX, Eraser, X } from 'lucide-react'
import { cue } from '../lib/sound'
import { removeMany, restartMany } from '../lib/store'
import { useTasks } from '../lib/useStore'

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

  useEffect(() => {
    if (open) {
      setClosing(false)
      setBusy({ failed: false, paused: false, completed: false })
      setConfirming({ failed: false, paused: false, completed: false })
      setResult(null)
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
  }, [open])

  const buckets = useMemo<Bucket[]>(() => {
    const by = (pred: (task: (typeof tasks)[number]) => boolean): number[] =>
      tasks.filter(pred).map((task) => task.id)
    return [
      {
        id: 'failed' as BucketId,
        label: '失败任务',
        copy: '链接过期或站点拒绝。重试会重新开始下载；移出只清理列表，不动文件。',
        ids: by((task) => task.status === 'error')
      },
      {
        id: 'paused' as BucketId,
        label: '已暂停任务',
        copy: '长期搁置的任务会让“继续已暂停”变得迟缓，也把列表压得很沉。',
        ids: by((task) => task.status === 'paused' || task.status === 'incomplete')
      },
      {
        id: 'completed' as BucketId,
        label: '已完成记录',
        copy: '从列表移除完成记录；文件保留在原位置，随时可以再下载。',
        ids: by((task) => task.status === 'complete')
      }
    ]
  }, [tasks])

  const totalCleanable = buckets.reduce((sum, bucket) => sum + bucket.ids.length, 0)

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
    try {
      if (action === 'retry') {
        const count = await restartMany(bucket.ids)
        setResult((current) => ({
          removed: current?.removed ?? 0,
          retried: (current?.retried ?? 0) + count
        }))
      } else {
        await removeMany(bucket.ids, false)
        setResult((current) => ({
          removed: (current?.removed ?? 0) + bucket.ids.length,
          retried: current?.retried ?? 0
        }))
      }
      cue('success')
    } catch {
      cue('droplet')
    } finally {
      setBusy((current) => ({ ...current, [bucket.id]: false }))
      setConfirming((current) => ({ ...current, [bucket.id]: false }))
    }
  }

  return (
    <div
      className={`t-modal-scrim absolute inset-0 z-40 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px] ${closing ? 'is-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="整理任务库"
        className={`t-modal relative max-h-full w-[min(540px,100%)] overflow-y-auto rounded-[20px] border border-line-strong bg-raised/98 shadow-[0_28px_80px_rgb(0_0_0/0.45)] backdrop-blur-md scroll-quiet ${closing ? 'is-closing' : 'is-open'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[140px] rounded-t-[20px]"
          style={{
            background:
              'radial-gradient(90% 120% at 82% -20%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 62%)'
          }}
        />

        <div className="relative flex items-start justify-between px-6 pt-6">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-serif text-[24px] leading-tight tracking-[-0.01em] text-paper">
              <Eraser size={19} strokeWidth={1.7} className="translate-y-px text-copper" />
              整理任务库
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-mist">
              任务库越大，列表和引擎越沉。挑出不再需要的那部分，一次清走。
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg p-1.5 text-mist transition-colors hover:bg-line hover:text-paper"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div className="relative space-y-2.5 px-6 py-5">
          {totalCleanable === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-panel px-6 py-9 text-center">
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
                  className={`rounded-[14px] border bg-panel px-4 py-3.5 transition-opacity ${
                    bucket.ids.length === 0 ? 'border-line/60 opacity-45' : 'border-line'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Icon size={16} strokeWidth={1.8} className={`mt-0.5 shrink-0 ${tone.icon}`} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13px] font-medium text-paper">{bucket.label}</span>
                          <span className={`rounded-full px-1.5 py-px font-mono text-[10.5px] tabular-nums ${tone.chip}`}>
                            {bucket.ids.length}
                          </span>
                        </div>
                        <p className="mt-1 max-w-[360px] text-[11.5px] leading-relaxed text-mist">{bucket.copy}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {bucket.id === 'failed' && bucket.ids.length > 0 ? (
                        <button
                          type="button"
                          disabled={busy.failed}
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
                          disabled={busy[bucket.id]}
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
            onClick={handleClose}
            data-cuelume-press
            className="shrink-0 rounded-full border border-line px-3.5 py-1 text-[12px] text-fog transition-colors hover:bg-line hover:text-paper"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
