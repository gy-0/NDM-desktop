import { useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { TRASH_NAME } from '../lib/platform'

export function DeleteTasksDialog({
  count,
  preferredDeleteFile,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  count: number
  preferredDeleteFile: boolean
  busy: boolean
  error: string
  onConfirm: (deleteFile: boolean) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel])

  const title = count === 1 ? '删除这个任务？' : `删除这 ${count} 个任务？`

  return (
    <div
      className="t-modal-scrim absolute inset-0 z-50 grid place-items-center bg-ink/60 p-6 backdrop-blur-[2px]"
      onClick={() => { if (!busy) onCancel() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-tasks-title"
        aria-describedby={error ? 'delete-tasks-description delete-tasks-status' : 'delete-tasks-description'}
        aria-busy={busy}
        className="t-modal is-open w-[min(440px,100%)] rounded-[20px] border border-line-strong bg-raised/98 p-5 shadow-[0_28px_80px_rgb(0_0_0/0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-clay/12 text-clay">
            <Trash2 size={17} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <h2 id="delete-tasks-title" className="font-serif text-[22px] leading-tight text-paper">{title}</h2>
            <p id="delete-tasks-description" className="mt-1.5 text-[12px] leading-relaxed text-mist">
              仅移除会保留文件；移到{TRASH_NAME}会同时处理已经下载的文件。操作会在下载引擎确认后生效。
            </p>
          </div>
        </div>

        <p
          id="delete-tasks-status"
          role="status"
          aria-live="polite"
          className={error ? 'mt-3 rounded-[9px] bg-clay/10 px-3 py-2 text-[11.5px] leading-relaxed text-clay' : 'sr-only'}
        >
          {error}
        </p>

        <div className="mt-5 grid gap-2">
          <button
            type="button"
            autoFocus={!preferredDeleteFile}
            disabled={busy}
            onClick={() => onConfirm(false)}
            className="h-10 rounded-[10px] border border-line-strong text-[12.5px] text-paper transition-[background-color,scale] hover:bg-line active:scale-[0.98] disabled:cursor-wait disabled:opacity-55"
          >
            {busy && !preferredDeleteFile ? '正在移除…' : '仅从列表移除'}
          </button>
          <button
            type="button"
            autoFocus={preferredDeleteFile}
            disabled={busy}
            onClick={() => onConfirm(true)}
            className="h-10 rounded-[10px] bg-clay/15 text-[12.5px] font-medium text-clay transition-[background-color,scale] hover:bg-clay/25 active:scale-[0.98] disabled:cursor-wait disabled:opacity-55"
          >
            {busy && preferredDeleteFile ? `正在移到${TRASH_NAME}…` : `同时移到${TRASH_NAME}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-8 text-[11.5px] text-mist hover:text-paper disabled:cursor-wait disabled:opacity-55"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
