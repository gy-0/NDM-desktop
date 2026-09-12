import { Dialog } from '@base-ui/react/dialog'
import { Bookmark, Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { viewCriteriaSummary, viewSortSummary, type SavedView, type SavedViewMutationResult } from '../lib/savedViews'
import './ui/workspace.css'
import './ui/saved-views.css'

export function SavedViewsDialog({ open, onClose, views, onApply, onRename, onRemove, activeId, error }: {
  open: boolean
  onClose: () => void
  views: readonly SavedView[]
  onApply: (view: SavedView) => void
  onRename: (id: string, name: string) => SavedViewMutationResult
  onRemove: (id: string) => SavedViewMutationResult
  activeId?: string
  error?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) { setEditing(null); setLocalError(null) }
    else if (error) setLocalError(error)
  }, [open, error])
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="workspace-dialog-backdrop" />
        <Dialog.Viewport className="workspace-dialog-viewport">
          <Dialog.Popup className="workspace-dialog-popup saved-views-dialog">
            <header className="flex items-start justify-between gap-4 p-5 pb-4">
              <div><Dialog.Title className="text-[20px] font-semibold tracking-[-0.02em] text-paper">常用视图</Dialog.Title><Dialog.Description className="mt-1.5 text-[13px] text-mist">保存常用的筛选和排序，下次直接打开。</Dialog.Description></div>
              <Dialog.Close aria-label="关闭常用视图" className="grid size-8 place-items-center rounded-control text-mist hover:bg-line"><X size={17} aria-hidden /></Dialog.Close>
            </header>
            {views.length ? <ul className="saved-views-list">
              {views.map(view => (
                <li key={view.id} data-saved-view={view.id} className="saved-view-row" data-current={view.id === activeId || undefined}>
                  {editing === view.id ? <form className="saved-view-rename" onSubmit={event => {
                    event.preventDefault()
                    const result = onRename(view.id, name)
                    if (result.ok) { setEditing(null); setLocalError(null) }
                    else setLocalError(result.error)
                  }}>
                    <input ref={input} className="saved-view-input min-w-0 flex-1" aria-label="重命名视图" value={name} maxLength={80} onChange={event => { setName(event.target.value); setLocalError(null) }} />
                    <button type="submit" className="saved-view-secondary" disabled={!name.trim()}>保存</button><button type="button" className="saved-view-secondary" onClick={() => { setEditing(null); setLocalError(null) }}>取消</button>
                  </form> : <>
                    <button type="button" className="saved-view-open" onClick={() => { onApply(view); onClose() }} aria-label={`打开视图：${view.name}`}>
                      <span aria-hidden className="saved-view-mark"><Bookmark size={17} strokeWidth={1.6} /></span>
                      <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-[14px] font-medium text-paper">{view.name}</span>{view.id === activeId ? <Check size={14} className="shrink-0 text-mist" aria-label="当前视图" /> : null}</span><span className="mt-1 line-clamp-2 break-words text-[12px] leading-relaxed text-mist" title={`${viewCriteriaSummary(view.criteria)} · ${viewSortSummary(view.sort)}`}>{viewCriteriaSummary(view.criteria)} · {viewSortSummary(view.sort)}</span></span>
                    </button>
                    <div className="saved-view-row-actions"><button type="button" className="saved-view-secondary" aria-label={`重命名视图：${view.name}`} onClick={() => { setEditing(view.id); setName(view.name); setLocalError(null) }}>重命名</button><button type="button" className="saved-view-secondary" aria-label={`移除视图：${view.name}`} onClick={() => { const result = onRemove(view.id); setLocalError(result.ok ? null : result.error) }}>移除</button></div>
                  </>}
                </li>
              ))}
            </ul> : <div className="grid justify-items-center px-8 py-10 text-center"><span aria-hidden className="saved-view-mark mb-4"><Bookmark size={22} strokeWidth={1.5} /></span><h3 className="text-[16px] font-medium text-paper">把常找的下载放在手边</h3><p className="mt-2 max-w-[300px] text-[13px] leading-relaxed text-mist">在列表的“筛选”中选好条件，再保存为常用视图。</p></div>}
            {localError ? <p role="status" className="px-5 py-3 text-[13px] text-clay">{localError}</p> : null}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
