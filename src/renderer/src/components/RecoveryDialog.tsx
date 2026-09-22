import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import { browserPageMediaURL, type BrowserPageMediaChoice } from '../../../shared/browserPageMedia'
import { BrowserPageMediaPicker } from './BrowserPageMediaPicker'
import { recoveryPage, taskRecoveryMessage } from '../lib/taskRecovery'
import { getTasks, toggle } from '../lib/store'
import { IS_WINDOWS } from '../lib/platform'
import type { Task } from '../lib/types'

const primary = 'ndm-control h-9 rounded-lg bg-paper px-4 text-[13px] text-ink disabled:opacity-50'
const secondary = 'ndm-control h-9 rounded-lg border border-line px-4 text-[13px] text-paper disabled:opacity-50'

export function RecoveryDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const page = recoveryPage(task)
  const browserPage = !IS_WINDOWS && task.linkType !== 'ytdlp' && page ? browserPageMediaURL(page) : null
  const [choice, setChoice] = useState<BrowserPageMediaChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [redownload, setRedownload] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  const cancel = useRef<HTMLButtonElement>(null)
  const confirmation = useRef<HTMLParagraphElement>(null)
  const failure = useRef<HTMLParagraphElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    // Disabling the initiating button removes native keyboard focus. Announce
    // the result before offering the next action; never auto-focus redownload.
    if (!busy) {
      if (error) failure.current?.focus()
      else if (redownload) confirmation.current?.focus()
    }
  }, [busy, error, redownload])

  const recover = async (): Promise<void> => {
    if (pending.current) return
    const current = getTasks().find(item => item.id === task.id)
    if (!current || !['error', 'paused', 'incomplete'].includes(current.status) || current.url !== task.url
      || (current.recoveryGeneration ?? 0) !== (task.recoveryGeneration ?? 0)) {
      setError('任务状态已经变化，请关闭后重新选择。'); return
    }
    pending.current = true; setBusy(true); setError('')
    try {
      if (task.linkType === 'ytdlp') {
        await toggle(task.id)
      } else if (choice && page) {
        const result = await window.ndm?.request('recoverBrowserPageMedia', {
          taskID: task.id, expectedURL: task.url, expectedGeneration: task.recoveryGeneration ?? 0,
          ...choice, pageURL: task.pageURL, redownload
        }) as { ok?: boolean; result?: string } | undefined
        if (!result?.ok) throw new Error('恢复请求未完成')
        if (result.result === 'needsRedownload') { if (alive.current) setRedownload(true); return }
        if (result.result !== 'started') throw new Error('恢复结果未确认')
      } else return
      if (alive.current) onClose()
    } catch {
      if (alive.current) { setChoice(null); setRedownload(false); setError('暂时未能恢复。请确认原网页可以正常下载或播放，然后重新读取页面。原有进度已保留。') }
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const openPage = async (): Promise<void> => {
    if (!page) return
    try { if (!await window.ndm?.openExternal(page)) throw new Error('Page did not open') }
    catch { if (alive.current) setError('未能打开来源网页，请在原浏览器中打开后再试。') }
  }

  return <Dialog.Root open onOpenChange={(open, details) => { if (!open) { if (pending.current) details.cancel(); else onClose() } }}>
    <Dialog.Portal><Dialog.Backdrop className="workspace-dialog-backdrop" />
      <Dialog.Viewport className="workspace-dialog-viewport">
        <Dialog.Popup initialFocus={cancel} finalFocus={() => previousFocus.current?.isConnected ? previousFocus.current : document.getElementById('ndm-search')}
          className="workspace-dialog-popup w-[min(480px,100%)] max-h-[85vh] overflow-y-auto rounded-xl border border-line-strong bg-raised p-5 shadow-dialog" aria-busy={busy}>
          <Dialog.Title className="text-[19px] font-semibold text-paper">恢复下载</Dialog.Title>
          <Dialog.Description className="mt-2 break-words text-[13px] leading-relaxed text-fog">{task.filename || task.title}</Dialog.Description>
          <p className="mt-4 text-[13px] leading-relaxed text-paper">{taskRecoveryMessage(task)}</p>
          {browserPage && task.linkType !== 'ytdlp' ? <BrowserPageMediaPicker pageURL={browserPage} disabled={busy} choice={choice}
            autoRead onSelect={value => { setChoice(value); setRedownload(false); setError('') }} /> : null}
          {!browserPage && page && task.linkType !== 'ytdlp' ? <p className="mt-3 text-[13px] leading-relaxed text-fog">这个来源暂不支持自动重新获取。请在原网页重新点击下载；不要复制已经失效的下载地址。</p> : null}
          {redownload ? <p ref={confirmation} tabIndex={-1} role="status" className="mt-4 rounded-lg border border-line p-3 text-[13px] leading-relaxed text-paper">已找到可下载的版本，但无法确认它与原有片段完全相同。重新下载会沿用文件名和保存位置，保留旧进度，不会另建重复任务。</p> : null}
          {error ? <p ref={failure} tabIndex={-1} role="alert" className="mt-3 text-[13px] text-clay">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button ref={cancel} type="button" disabled={busy} className={secondary} onClick={onClose}>稍后处理</button>
            {page && !browserPage ? <button type="button" disabled={busy} className={secondary} onClick={() => void openPage()}>打开来源网页</button> : null}
            {task.linkType === 'ytdlp' || choice ? <button type="button" disabled={busy} className={primary} onClick={() => void recover()}>{busy ? '正在恢复…' : redownload ? '重新下载' : task.linkType === 'ytdlp' ? '重新读取并继续' : '恢复这个下载'}</button> : null}
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
