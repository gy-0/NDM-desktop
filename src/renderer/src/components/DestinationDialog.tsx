import { Dialog } from '@base-ui/react/dialog'
import { Folder } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chooseFolder, confirmDestination, getEngineSettings, getTasks } from '../lib/store'
import type { Task } from '../lib/types'

export function DestinationDialog({ task, onClose }: { task: Task; onClose: (taskID: number) => void }) {
  const [folder, setFolder] = useState(task.folderPath || '')
  const [defaultFolder, setDefaultFolder] = useState(task.folderPath || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const alive = useRef(true)
  const edited = useRef(false)
  const choice = useRef(0)
  const pending = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    alive.current = true
    void getEngineSettings().then(settings => {
      if (!alive.current) return
      const path = task.folderPath || settings?.downloadDirectory || ''
      setDefaultFolder(path)
      if (!edited.current) setFolder(path)
      if (!path) setError('未能读取默认目录，请选择保存位置。')
    }).catch(() => { if (alive.current && !task.folderPath && !edited.current) setError('未能读取默认目录，请选择保存位置。') })
    return () => { alive.current = false; choice.current++ }
  }, [])
  const browse = async () => {
    if (pending.current || choosing) return
    const request = ++choice.current
    setChoosing(true)
    try {
      const selected = await chooseFolder(folder)
      if (!alive.current || request !== choice.current) return
      if (selected) { edited.current = true; setFolder(selected); setError('') }
    } catch { if (alive.current) setError('未能打开目录选择器，请重试。') }
    finally { if (alive.current && request === choice.current) setChoosing(false) }
  }
  const confirm = async () => {
    if (pending.current || choosing || !folder.trim()) return
    if (!getTasks().find(current => current.id === task.id)?.awaitingDestination) { onClose(task.id); return }
    pending.current = true; setBusy(true); setError('')
    try {
      await confirmDestination(task.id, folder.trim())
      if (alive.current) onClose(task.id)
    } catch { if (alive.current) setError('未能确认保存目录，请确认保存位置可用后重试。') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={(open, details) => { if (!open) { if (busy) details.cancel(); else onClose(task.id) } }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="workspace-dialog-backdrop" />
      <Dialog.Viewport className="workspace-dialog-viewport">
        <Dialog.Popup initialFocus={cancel} finalFocus={() => previousFocus.current?.isConnected ? previousFocus.current : document.getElementById('ndm-search')}
          className="workspace-dialog-popup w-[min(440px,100%)] rounded-xl border border-line-strong bg-raised p-5 shadow-dialog" aria-busy={busy}>
          <Dialog.Title className="text-[19px] font-semibold text-paper">选择保存目录</Dialog.Title>
          <Dialog.Description className="mt-2 break-words text-[12px] leading-relaxed text-mist">{task.filename || task.title}</Dialog.Description>
          <div className="mt-5 flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel/60 px-3 py-2">
            <Folder size={16} className="shrink-0 text-mist" />
            <span data-destination-path title={folder} className="min-w-0 flex-1 truncate text-[12px] text-paper">{folder || '请选择目录'}</span>
            <button type="button" disabled={busy || choosing} onClick={() => void browse()} className="shrink-0 px-2 py-1 text-[12px] text-paper disabled:opacity-50">浏览</button>
          </div>
          {defaultFolder && folder !== defaultFolder ? <button type="button" disabled={busy || choosing} className="mt-2 text-[12px] text-mist" onClick={() => { edited.current = true; setFolder(defaultFolder); setError('') }}>使用默认目录</button> : null}
          <p role="status" className={error ? 'mt-3 text-[12px] text-clay' : 'sr-only'}>{error}</p>
          <div className="mt-5 flex justify-end gap-2">
            <button ref={cancel} type="button" disabled={busy} onClick={() => onClose(task.id)} className="ndm-control h-9 rounded-lg px-4 text-[12px] text-mist">稍后选择</button>
            <button type="button" disabled={busy || choosing || !folder.trim()} onClick={() => void confirm()} className="ndm-control h-9 rounded-lg bg-paper px-4 text-[12px] text-ink disabled:opacity-50">{busy ? '正在确认…' : '确认并开始下载'}</button>
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
