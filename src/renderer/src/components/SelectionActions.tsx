import { Copy, Pause, Play, Trash2, X, type LucideIcon } from 'lucide-react'
import { formatBytes } from '../lib/format'
import type { Task } from '../lib/types'

export function SelectionActions({ tasks, busy, action, resumeCount, pauseCount, describedBy, onResume, onPause, onCopy, onDelete, onClear }: {
  tasks: readonly Task[]
  busy: boolean
  describedBy?: string
  action: 'pause' | 'resume' | null
  resumeCount: number
  pauseCount: number
  onResume: () => void
  onPause: () => void
  onCopy: () => void
  onDelete: () => void
  onClear: () => void
}) {
  const bytes = tasks.reduce((sum, task) => sum + Math.max(0, task.fileSize || 0), 0)
  const recording = tasks.some(task => task.isLiveRecording && task.status === 'downloading')
  const actions: { label: string; icon: LucideIcon; run: () => void; destructive?: boolean }[] = [
    ...(resumeCount ? [{label:action === 'resume' ? '正在继续…' : '继续所选', icon:Play, run:onResume}] : []),
    ...(pauseCount ? [{label:action === 'pause' ? '正在暂停…' : recording ? '暂停并保存' : '暂停所选', icon:Pause, run:onPause}] : []),
    {label:'复制链接', icon:Copy, run:onCopy},
    {label:'删除所选', icon:Trash2, run:onDelete, destructive:true}
  ]
  return <div className="selection-actions" role="toolbar" aria-label="批量任务操作" aria-busy={busy} aria-describedby={describedBy}>
    <div className="selection-summary" role="status"><strong>已选 {tasks.length} 项</strong>{bytes > 0 ? <span>{formatBytes(bytes)}{tasks.some(task => !task.fileSize) ? ' 以上' : ''}</span> : null}</div>
    <div className="selection-buttons">
      {actions.map(item => <button key={item.label} type="button" title={item.label} aria-label={item.label}
        disabled={busy || !tasks.length} aria-describedby={describedBy} data-destructive={item.destructive || undefined} onClick={item.run}>
        <item.icon size={15} strokeWidth={1.8} aria-hidden /><span>{item.label}</span>
      </button>)}
      <button type="button" aria-label="取消选择" title="取消选择" disabled={busy} onClick={onClear}><X size={16} aria-hidden /></button>
    </div>
  </div>
}
