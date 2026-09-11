import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { CheckCircle2, CircleX } from 'lucide-react'
import { cue } from '../lib/sound'
import { removeMany } from '../lib/store'
import { useTasks } from '../lib/useStore'
import { historyTaskIDs, historyClearError } from '../lib/downloadHistory'

/** A small history command. Paused and running downloads are never candidates. */
export function CleanupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useTasks()
  const [includeCompleted, setIncludeCompleted] = useState(true)
  const [includeFailed, setIncludeFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removed, setRemoved] = useState<number | null>(null)
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    setIncludeCompleted(true)
    setIncludeFailed(false)
    setError('')
    setRemoved(null)
  }, [open])

  const completed = tasks.filter(task => task.status === 'complete')
  const failed = tasks.filter(task => task.status === 'error')
  const selected = historyTaskIDs(tasks, { completed: includeCompleted, failed: includeFailed })
  async function clearHistory(): Promise<void> {
    if (inFlight.current || selected.length === 0) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const count = await removeMany(selected, false)
      setRemoved(current => (current ?? 0) + count)
      cue('success')
    } catch (failure) {
      setError(historyClearError(failure))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  if (!open) return null
  return (
    <AlertDialog.Root open onOpenChange={(next, details) => {
      if (next) return
      if (inFlight.current) details.cancel()
      else onClose()
    }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="workspace-dialog-backdrop" />
        <AlertDialog.Viewport className="workspace-dialog-viewport">
          <AlertDialog.Popup initialFocus={cancelRef} aria-busy={busy}
            className="workspace-dialog-popup w-[min(420px,100%)] rounded-xl border border-line-strong bg-panel p-6 shadow-dialog">
            <AlertDialog.Title className="text-[20px] font-medium tracking-tight text-paper">清除下载记录</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-[13px] leading-relaxed text-mist">
              下载文件会保留在原位置。
            </AlertDialog.Description>
            <div className="my-5 space-y-2">
              {[
                { label: '已完成', count: completed.length, checked: includeCompleted, change: setIncludeCompleted, Icon: CheckCircle2 },
                { label: '失败', count: failed.length, checked: includeFailed, change: setIncludeFailed, Icon: CircleX }
              ].map(({ label, count, checked, change, Icon }) => (
                <label key={label} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2 text-[14px] hover:bg-raised">
                  <input type="checkbox" checked={checked} disabled={busy || count === 0} onChange={event => change(event.target.checked)} className="size-4 accent-[var(--paper)]" />
                  <Icon size={16} className="text-mist" aria-hidden />
                  <span className="flex-1 text-fog">{label}</span>
                  <span className="text-[13px] tabular-nums text-mist">{count} 条</span>
                </label>
              ))}
            </div>
            <p id="clear-history-status" role="status" aria-live="polite" className={`text-[13px] leading-relaxed ${error ? 'text-clay' : 'text-mist'}`}>
              {error || (removed !== null ? `已清除 ${removed} 条记录` : completed.length + failed.length === 0 ? '没有可清除的下载记录' : '正在下载和已暂停的任务不受影响。')}
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button ref={cancelRef} type="button" disabled={busy} onClick={onClose}
                className="h-9 rounded-lg border border-line px-4 text-[13px] text-fog hover:bg-raised disabled:opacity-50">{removed === null ? '取消' : '完成'}</button>
              <button type="button" disabled={busy || selected.length === 0} aria-describedby="clear-history-status" onClick={() => void clearHistory()}
                className="h-9 rounded-lg border border-line-strong bg-raised px-4 text-[13px] font-medium text-paper hover:bg-line disabled:opacity-45">
                {busy ? '正在清除…' : `清除 ${selected.length} 条记录`}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
