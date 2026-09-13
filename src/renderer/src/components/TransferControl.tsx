import { Popover } from '@base-ui/react/popover'
import { ArrowDownToLine, ArrowUpRight, ChevronRight, Clock3, CircleAlert, FileDown, Radio, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference'
import { formatBytes, formatSpeed, fractionOf, taskDisplayTitle } from '../lib/format'
import { PHASE_LABEL, type Task } from '../lib/types'
import { TransferActionIcon } from './ui/TransferActionIcon'
import './ui/transfer-control.css'

export type TransferControlProps = {
  children?: ReactNode
  temporaryLabel?: string
  activeCount: number
  liveCount: number
  waitingCount?: number
  bytesPerSecond: number
  tasks?: Task[]
  onInspectTask?: (task: Task) => void
  busy?: boolean
  error?: string
  onPauseAll: () => void
  onShowActive?: () => void
}

function transferSpeed(bytesPerSecond: number) {
  const rate = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0
  return rate >= 1024 ** 3
    ? { value: (rate / 1024 ** 3).toFixed(1), unit: 'GB/s' }
    : formatSpeed(rate)
}

function TransferTaskCard({ task, onInspect }: { task: Task; onInspect?: () => void }) {
  const live = task.status === 'downloading' && task.isLiveRecording
  const waiting = task.status === 'waiting'
  const hasProgress = !live && (task.fileSize > 0 || Number.isFinite(task.progressFraction))
  const progress = fractionOf(task)
  const title = taskDisplayTitle(task)
  const speed = transferSpeed(task.bytesPerSecond)
  const status = task.awaitingDestination ? '待选保存目录'
    : waiting ? '等待中'
      : task.phase && task.phase !== 'transferring' ? PHASE_LABEL[task.phase]
        : live ? '正在录制' : '正在下载'
  const content = <>
    <span className="transfer-task-icon" aria-hidden>{live ? <Radio size={17} /> : waiting ? <Clock3 size={17} /> : <FileDown size={17} />}</span>
    <span className="transfer-task-detail">
      <span className="transfer-task-title text-label" title={title}>{title}</span>
      <span className="transfer-task-meta text-meta"><span>{status}</span><span>{waiting ? '' : live ? formatBytes(task.completedBytes) : `${speed.value} ${speed.unit}`}</span></span>
      {hasProgress ? <span className="transfer-task-progress" role="progressbar" aria-label={`${title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ transform: `scaleX(${progress})` }} /></span> : null}
    </span>
    <span className="transfer-task-trailing" aria-hidden>{hasProgress ? <span className="text-meta tabular-nums">{Math.round(progress * 100)}%</span> : null}{onInspect ? <ChevronRight size={13} /> : null}</span>
  </>
  return onInspect
    ? <button type="button" className="transfer-task-card" data-island-task={task.id} data-waiting={waiting || undefined} onClick={onInspect} aria-label={`查看任务：${title}`}>{content}</button>
    : <div className="transfer-task-card" data-island-task={task.id} data-waiting={waiting || undefined}>{content}</div>
}

export function TransferControl({
  activeCount, liveCount, waitingCount = 0, bytesPerSecond, tasks = [], onInspectTask,
  busy = false, error, onPauseAll, onShowActive, temporaryLabel, children
}: TransferControlProps) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotionPreference()
  const errorId = useId()
  const active = Math.max(0, Math.floor(activeCount))
  const live = Math.min(active, Math.max(0, Math.floor(liveCount)))
  const waiting = Math.max(0, Math.floor(waitingCount))
  const idle = active === 0 && waiting === 0
  const speed = transferSpeed(bytesPerSecond)
  const speedLabel = `${speed.value} ${speed.unit}`
  const fullLabel = active > 0
    ? `传输：${active} 项进行中${live ? `，其中 ${live} 项直播` : ''} · ${speedLabel}${waiting ? ` · ${waiting} 项等待中` : ''}`
    : `传输${waiting ? ` · ${waiting} 项等待中` : ' · 当前没有进行中的下载'}`
  const pauseLabel = live > 0 ? '暂停下载并保存直播' : '暂停所有下载'
  // Keep the dashboard bounded even when the main list contains thousands of tasks.
  const visibleTasks: Task[] = []
  for (const status of ['downloading', 'waiting'] as const) {
    for (const task of tasks) {
      if (visibleTasks.length === 3) break
      if (task.status === status) visibleTasks.push(task)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal="trap-focus">
      <Popover.Trigger className="transfer-control-trigger h-control text-label" data-transfer-control data-idle={idle || undefined} aria-label="传输状态" title={temporaryLabel ? `${fullLabel} · ${temporaryLabel}` : fullLabel}>
        <span className="transfer-control-icon" data-temporary={temporaryLabel || undefined}>{temporaryLabel ? <Clock3 size={14} aria-hidden /> : <ArrowDownToLine size={14} aria-hidden />}</span>
        {active > 0 ? <>
          <span className="transfer-control-count tabular-nums" aria-label={`${active} 项进行中`}>{active > 99 ? '99+' : active}</span>
          <span className="transfer-control-speed tabular-nums" aria-hidden><span>{speed.value}</span><span className="text-meta">{speed.unit}</span></span>
        </> : waiting > 0 ? <span className="transfer-control-count tabular-nums" aria-label={`${waiting} 项等待中`}>{waiting > 99 ? '99+' : waiting}</span> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={9} align="start" collisionPadding={12} className="transfer-control-positioner">
          <Popover.Popup className="transfer-control-popup" data-transfer-island data-reduced-motion={reduced || undefined} aria-describedby={error ? errorId : undefined} onKeyDown={(event) => {
            // This island owns keys, including Space: don't preview a task behind it.
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
            event.stopPropagation()
          }}>
            <div className="transfer-control-body" inert={!open} aria-hidden={!open || undefined}>
              <div className="transfer-control-heading">
                <Popover.Title className="text-body font-medium">传输中心</Popover.Title>
                <span className="transfer-control-state text-meta" data-active={active > 0 || undefined}><span aria-hidden />{active > 0 ? '正在传输' : waiting > 0 ? '等待开始' : '就绪'}</span>
                <Popover.Close className="transfer-control-close" aria-label="收起传输面板"><X size={15} aria-hidden /></Popover.Close>
              </div>
              <div className="transfer-control-dashboard">
                <div className="transfer-control-rate">
                  <p className="text-meta text-mist">总下载速度</p>
                  <p className="transfer-control-total" aria-live="off"><span>{speed.value}</span><span>{speed.unit}</span></p>
                </div>
                <dl className="transfer-control-counts">
                  <div><dt className="text-meta"><ArrowDownToLine size={12} aria-hidden />进行中</dt><dd>{active}<span className="text-meta">项</span></dd></div>
                  <div><dt className="text-meta"><Clock3 size={12} aria-hidden />等待中</dt><dd>{waiting}<span className="text-meta">项</span></dd></div>
                </dl>
              </div>
              {visibleTasks.length > 0 ? <div className="transfer-control-tasks">
                <div className="transfer-control-section-heading"><span className="text-meta">{active + waiting > visibleTasks.length ? `当前任务 · 展示 ${visibleTasks.length} 项` : '当前任务'}</span>
                  {onShowActive ? <button type="button" className="transfer-control-view text-meta" onClick={() => { setOpen(false); onShowActive() }}>查看全部 <ArrowUpRight size={12} aria-hidden /></button> : null}
                </div>
                <div className="transfer-control-task-list">{visibleTasks.map(task => <TransferTaskCard key={task.id} task={task} onInspect={onInspectTask ? () => { setOpen(false); onInspectTask(task) } : undefined} />)}</div>
              </div> : idle ? <div className="transfer-control-empty text-label"><span className="transfer-control-empty-icon"><ArrowDownToLine size={19} aria-hidden /></span><div><p>当前没有进行中的下载</p><p className="text-meta text-mist">新的传输会在这里汇集</p></div></div> : onShowActive ? <button type="button" className="transfer-control-view transfer-control-view-standalone text-label" onClick={() => { setOpen(false); onShowActive() }}>查看任务 <ArrowUpRight size={12} aria-hidden /></button> : null}
              {live > 0 ? <p className="transfer-control-live-note text-meta"><Radio size={12} aria-hidden /><span>{live} 项直播录制 · 停止后保存为文件</span></p> : null}
              {children}
              {active > 0 || waiting > 0 || busy ? <div className="transfer-control-footer">
                <button type="button" className="transfer-control-pause text-label" disabled={busy} aria-busy={busy} aria-describedby={error ? errorId : undefined} onClick={onPauseAll}>
                  <TransferActionIcon state={busy ? 'pending' : 'pause'} size={14} />{busy ? '正在处理…' : pauseLabel}
                </button>
              </div> : null}
              {error ? <p id={errorId} role="status" aria-live="polite" className="transfer-control-error text-label"><CircleAlert size={13} aria-hidden /><span>{error}</span></p> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
