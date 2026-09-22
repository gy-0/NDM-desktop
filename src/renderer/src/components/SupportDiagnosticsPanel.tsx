import { useEffect, useRef, useState } from 'react'
import type { SupportPreview, SupportReply } from '../../../shared/supportDiagnostics'
import { openExternal } from '../lib/store'

export function SupportDiagnosticsPanel() {
  const [preview, setPreview] = useState<SupportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const pending = useRef(false), reportPending = useRef(false), mounted = useRef(true)
  const [openingReport, setOpeningReport] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const perform = async (exporting: boolean): Promise<void> => {
    if (pending.current || exporting && !preview) return
    pending.current = true; setBusy(true); setMessage(''); setFailed(false)
    try {
      const reply = await window.ndm?.request(exporting ? 'supportDiagnosticsExport' : 'supportDiagnosticsPreview', exporting ? { token: preview!.token } : {}) as SupportReply | undefined
      if (!mounted.current) return
      if (!reply?.ok) { setFailed(true); setMessage(reply && !reply.ok ? reply.error : '暂时无法生成诊断，请重试。'); return }
      if (reply.preview) setPreview(reply.preview)
      if (reply.saved) setMessage('诊断已保存。反馈问题时可附上这个文件，并说明复现步骤。')
      if (reply.canceled) setMessage('已取消保存，诊断预览仍然保留。')
    } catch { if (mounted.current) { setFailed(true); setMessage('诊断操作未完成，请重试。') } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const control = 'rounded-control border border-line-strong px-3 py-2 text-[13px] text-paper hover:bg-line disabled:opacity-50'
  const reportProblem = async (): Promise<void> => {
    if (reportPending.current) return
    reportPending.current = true
    setOpeningReport(true)
    setMessage(''); setFailed(false)
    try {
      if (!await openExternal('https://github.com/gy-0/NDM-desktop/issues/new?template=bug_report.md')) {
        throw new Error('open failed')
      }
    } catch {
      if (mounted.current) {
        setFailed(true)
        setMessage('未能打开问题反馈页，请在浏览器访问 github.com/gy-0/NDM-desktop/issues。')
      }
    } finally { reportPending.current = false; if (mounted.current) setOpeningReport(false) }
  }
  return <div className="space-y-3" aria-label="支持诊断">
    <p className="text-[13px] leading-relaxed text-fog">遇到问题时，先生成诊断预览，再决定是否保存给支持人员。仅包含版本、连接状态和任务数量，不含下载地址、文件名或登录信息。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void perform(false)} className={control}>{busy ? '正在处理…' : preview ? '重新生成诊断' : '生成诊断预览'}</button>
      {preview ? <button type="button" disabled={busy} onClick={() => void perform(true)} className={control}>保存诊断文件…</button> : null}
      <button type="button" disabled={openingReport} onClick={() => void reportProblem()} className={control}>{openingReport ? '正在打开…' : '报告问题（GitHub）'}</button>
    </div>
    {preview ? <details open className="text-[13px] text-fog">
      <summary className="cursor-pointer text-paper">将要导出的内容</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 font-sans text-[13px] leading-relaxed" tabIndex={0} aria-label="诊断内容预览">{preview.text}</pre>
    </details> : null}
    <p className="text-[12px] text-mist">文件只保存到你选择的位置，不会自动上传。</p>
    <p className="text-[12px] leading-relaxed text-mist">问题反馈页是公开的。请只附上可公开分享的复现步骤和示例，不要粘贴登录信息或私有下载链接。</p>
    {message ? <p role={failed ? 'alert' : 'status'} className={`text-[13px] leading-relaxed ${failed ? 'text-clay' : 'text-fog'}`}>{message}</p> : null}
  </div>
}
