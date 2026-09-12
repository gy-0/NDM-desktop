import { fractionOf, formatBytes } from '../lib/format'
import type { Task } from '../lib/types'
import { SmoothProgressBar } from './SmoothProgressBar'

/** One reading order for the task: current state, received amount, then time. */
export function TaskTransferSummary({ task, status, amount, eta }: {
  task: Task
  status: string
  amount: string
  eta: string
}) {
  const active = task.status === 'downloading'
  const recording = Boolean(task.isLiveRecording)
  const determinate = !recording && (task.fileSize > 0 || Number.isFinite(task.progressFraction))
  const fraction = Math.min(1, Math.max(0, fractionOf(task)))
  const duration = Math.max(0, Math.floor(task.recordedDuration ?? 0))
  const clock = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`

  return (
    <div data-inspector-summary data-inspector-transfer-summary data-state={task.status} aria-label="任务概要">
      <div className="inspector-transfer-reading">
        <div className="min-w-0">
          <p className="inspector-transfer-state"><span aria-hidden />{status}</p>
          <p className="inspector-transfer-amount">{recording ? `已保存 ${formatBytes(task.completedBytes)}` : amount}</p>
        </div>
        {recording ? <span className="inspector-transfer-number" aria-label={`已录制 ${Math.floor(duration / 60)} 分 ${duration % 60} 秒`}>{clock}</span>
          : determinate ? <span className="inspector-transfer-number" aria-label={`已下载 ${Math.round(fraction * 100)}%`}>{Math.round(fraction * 100)}<span>%</span></span> : null}
      </div>
      {determinate ? (
        <div className="inspector-transfer-track">
          <SmoothProgressBar fraction={fraction} active={active} fillClassName={active ? 'bg-paper/80' : 'bg-mist'} trackClassName={active ? 'task-progress-warp' : ''} />
        </div>
      ) : null}
      {active ? <p className="inspector-transfer-timing">{recording ? task.phase === 'merging' ? '正在整理录制文件' : '停止后保存录制' : eta === '—' ? '剩余时间计算中' : `预计剩余 ${eta}`}</p> : null}
    </div>
  )
}
