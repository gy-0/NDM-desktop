import { useEffect, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import {
  formatBackupValue, SETTINGS_BACKUP_LABELS,
  type SettingsBackupPreview, type SettingsBackupReply
} from '../../../shared/settingsBackup'

export function SettingsBackupPanel({ onApplied }: { onApplied?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<SettingsBackupPreview | null>(null)
  const [confirmationUsed, setConfirmationUsed] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState(false)
  const mounted = useRef(true)
  const operationActive = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const perform = async (op: 'settingsBackupExport' | 'settingsBackupPreview' | 'settingsBackupApply'): Promise<void> => {
    if (operationActive.current || (op === 'settingsBackupApply' && (!preview || confirmationUsed))) return
    operationActive.current = true
    setBusy(true)
    setMessage('')
    setFailure(false)
    if (op === 'settingsBackupPreview') { setPreview(null); setConfirmationUsed(false) }
    if (op === 'settingsBackupApply') setConfirmationUsed(true)
    try {
      if (!window.ndm?.request) throw new Error('unavailable')
      const reply = await window.ndm.request(op, op === 'settingsBackupApply' ? { token: preview!.token } : {}) as SettingsBackupReply
      if (!mounted.current) return
      if (!reply || !reply.ok) {
        setFailure(true)
        const details = reply && !reply.ok && reply.unrestoredKeys?.length
          ? ` 待核对：${reply.unrestoredKeys.map(key => SETTINGS_BACKUP_LABELS[key]).join('、')}。` : ''
        setMessage((reply && !reply.ok ? reply.error : '未能完成操作，请检查下载引擎后重试。') + details)
      } else if ('preview' in reply) {
        setPreview(reply.preview)
        if (!reply.preview.changes.length) setMessage('备份中的可导入设置与本机相同。')
      } else if ('exported' in reply) {
        setMessage(`已导出 ${reply.filename}。`)
      } else if ('applied' in reply) {
        setPreview(null)
        setMessage(`已应用 ${reply.changedCount} 项设置，并核对保存结果。`)
      }
      if (op === 'settingsBackupApply') {
        // A failed update may have required compensation. Refresh the enclosing
        // settings page after either outcome, without obscuring the real result.
        await Promise.resolve(onApplied?.()).catch(() => undefined)
      }
    } catch {
      if (mounted.current) {
        setFailure(true)
        setMessage(op === 'settingsBackupApply'
          ? '未能确认导入结果。请重新打开设置核对当前值，再选择备份文件。'
          : '无法完成备份操作，请检查文件权限和下载引擎后重试。')
      }
    } finally {
      operationActive.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section aria-label="下载设置备份" className="space-y-3">
      <div>
        <h3 className="text-body font-medium text-paper">下载设置备份</h3>
        <p className="mt-1 text-meta leading-relaxed text-mist">保存下载目录、连接数、限速等设置。导入前先预览变更；代理和登录信息保留在本机。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void perform('settingsBackupExport')}
          className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-meta text-fog hover:bg-line disabled:opacity-40">
          <Download size={14} aria-hidden />导出备份
        </button>
        <button type="button" disabled={busy} onClick={() => void perform('settingsBackupPreview')}
          className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-meta text-fog hover:bg-line disabled:opacity-40">
          <Upload size={14} aria-hidden />{preview ? '重新选择备份' : '导入备份'}
        </button>
      </div>
      {busy ? <p role="status" className="text-meta text-mist">正在处理…</p> : null}
      {message ? <p role={failure ? 'alert' : 'status'} className={`text-meta leading-relaxed ${failure ? 'text-clay' : 'text-fog'}`}>{message}</p> : null}
      {preview ? <div className="space-y-3 rounded-control border border-line-strong p-3">
        <p className="break-all text-meta font-medium text-paper">{preview.filename}</p>
        {preview.changes.length ? <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-caption">
            <thead className="text-mist"><tr><th scope="col" className="w-1/3 py-1 pr-2 font-normal">设置</th><th scope="col" className="w-1/3 py-1 pr-2 font-normal">当前值</th><th scope="col" className="w-1/3 py-1 font-normal">导入后</th></tr></thead>
            <tbody className="text-fog">{preview.changes.map(change => <tr key={change.key} className="border-t border-line">
              <th scope="row" className="py-2 pr-2 align-top font-normal">{change.label}</th>
              <td className="break-all py-2 pr-2 align-top">{formatBackupValue(change.key, change.before)}</td>
              <td className="break-all py-2 align-top text-paper">{formatBackupValue(change.key, change.after)}</td>
            </tr>)}</tbody>
          </table>
        </div> : null}
        {preview.ignoredCount > 0 ? <p className="text-caption leading-relaxed text-mist">已忽略 {preview.ignoredCount} 项不在备份范围内或当前系统不支持的字段。</p> : null}
        {preview.notes.map(note => <p key={note} className="text-caption leading-relaxed text-mist">{note}</p>)}
        {preview.changes.length ? <p className="text-caption leading-relaxed text-mist">确认后应用以上变更；若保存失败，将尝试恢复原值并报告结果。</p> : null}
        <div className="flex gap-2">
          <button type="button" disabled={busy || confirmationUsed || !preview.changes.length} onClick={() => void perform('settingsBackupApply')}
            className="rounded-control border border-copper/30 bg-copper/10 px-3 py-2 text-meta font-medium text-paper hover:bg-copper/20 disabled:opacity-40">应用 {preview.changes.length} 项变更</button>
          <button type="button" disabled={busy} onClick={() => { setPreview(null); setMessage('') }}
            className="rounded-control border border-line-strong px-3 py-2 text-meta text-fog hover:bg-line disabled:opacity-40">关闭预览</button>
        </div>
      </div> : null}
    </section>
  )
}
