import { useRef, useState } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { FileMinus2, Trash2 } from 'lucide-react'
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Remember the button actually chosen, not the entry point's preference.
  const [deleteFile, setDeleteFile] = useState(preferredDeleteFile)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  const title = count === 1 ? '删除这个任务？' : `删除这 ${count} 个任务？`

  function confirm(removeFile: boolean): void {
    if (busy) return
    setDeleteFile(removeFile)
    onConfirm(removeFile)
  }

  return (
    <AlertDialog.Root open onOpenChange={(open, details) => {
      if (open) return
      if (busy) details.cancel()
      else onCancel()
    }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="workspace-dialog-backdrop" />
        <AlertDialog.Viewport className="workspace-dialog-viewport">
          <AlertDialog.Popup
            initialFocus={cancelRef}
            finalFocus={() => previousFocus.current?.isConnected ? previousFocus.current : document.getElementById('ndm-search')}
            aria-describedby={error ? 'delete-tasks-description delete-tasks-status' : 'delete-tasks-description'}
            aria-busy={busy}
            className="workspace-dialog-popup w-[min(440px,100%)] rounded-xl border border-line-strong bg-raised p-5 shadow-dialog"
          >
            <AlertDialog.Title className="text-[19px] font-semibold leading-tight text-paper">{title}</AlertDialog.Title>
            <AlertDialog.Description id="delete-tasks-description" className="mt-2 text-[12px] leading-relaxed text-mist">
              选择是否保留已经下载的文件。操作会在下载引擎确认后生效，未完成的任务会先停止。
            </AlertDialog.Description>

            <div className="mt-5 grid gap-2">
              <button type="button" disabled={busy} onClick={() => confirm(false)}
                className="flex min-h-16 items-center gap-3 rounded-lg border border-line-strong px-4 py-3 text-left transition-colors hover:bg-line disabled:cursor-wait disabled:opacity-55">
                <FileMinus2 size={18} className="shrink-0 text-fog" aria-hidden="true" />
                <span>
                  <span className="block text-[12.5px] font-medium text-paper">{busy && !deleteFile ? '正在移除…' : '仅从列表移除'}</span>
                  <span className="mt-0.5 block text-[11.5px] text-mist">保留已下载的文件</span>
                </span>
              </button>
              <button type="button" disabled={busy} onClick={() => confirm(true)}
                className="flex min-h-16 items-center gap-3 rounded-lg border border-clay/40 px-4 py-3 text-left transition-colors hover:bg-clay/10 disabled:cursor-wait disabled:opacity-55">
                <Trash2 size={18} className="shrink-0 text-clay" aria-hidden="true" />
                <span>
                  <span className="block text-[12.5px] font-medium text-clay">{busy && deleteFile ? `正在移到${TRASH_NAME}…` : `同时移到${TRASH_NAME}`}</span>
                  <span className="mt-0.5 block text-[11.5px] text-mist">从列表移除，并处理已下载的文件</span>
                </span>
              </button>
            </div>
            <p id="delete-tasks-status" role="status" aria-live="polite"
              className={error ? 'mt-3 border-l-2 border-clay px-3 py-1 text-[11.5px] leading-relaxed text-clay' : 'sr-only'}>{error}</p>
            <div className="mt-4 flex justify-end border-t border-line pt-3">
              <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}
                className="h-9 min-w-20 rounded-lg border border-line-strong px-4 text-[12px] text-paper transition-colors hover:bg-line disabled:cursor-wait disabled:opacity-55">取消</button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
