import { ArrowDownToLine, Check, CircleAlert, Clock3, Copy, Eye, FolderOpen, Pause, Play, RotateCw } from 'lucide-react'
import { memo, useState } from 'react'
import { formatBytes, formatSpeed, fractionOf, isDistinctTitle } from '../lib/format'
import { copyToClipboard, openFile, quickLook, revealFile } from '../lib/store'
import { CATEGORY_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { COMMAND_KEY, FILE_MANAGER } from '../lib/platform'
import { TypeMark } from './Marks'

function TaskRowImpl({
  task,
  selected,
  multiSelected,
  justCompleted = false,
  index,
  onSelect,
  onContextMenu,
  actionBusy,
  actionErrorId,
  onToggle,
  onRestart
}: {
  task: Task
  selected: boolean
  multiSelected?: boolean
  justCompleted?: boolean
  index: number
  onSelect: (e: React.MouseEvent, task: Task, index: number) => void
  onContextMenu?: (e: React.MouseEvent, task: Task) => void
  actionBusy: boolean
  actionErrorId?: string
  onToggle: (task: Task) => void
  onRestart: (task: Task) => void
}) {
  const fraction = fractionOf(task)
  const speed = formatSpeed(task.bytesPerSecond)
  const live = task.status === 'downloading'
  const failed = task.status === 'error'
  const completed = task.status === 'complete'
  const [copied, setCopied] = useState(false)
  const thumbnail = useTaskThumbnail(task)

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename

  const handleDoubleClick = (): void => {
    if (completed) {
      void openFile(filePath)
    } else {
      onToggle(task)
    }
  }

  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void copyToClipboard(task.url).then(() => {
      cue('success')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const isHighlighted = selected || multiSelected
  const hasProgress = completed || fraction > 0
  const progressLabel = hasProgress ? `${Math.round(Math.min(1, fraction) * 100)}%` : '—'
  return (
    <div
      data-task-state={task.status}
      className={`group relative border-b border-line/55 transition-[background-color,box-shadow] duration-100 ${
        isHighlighted
          ? 'bg-paper/[0.055] shadow-[inset_2px_0_0_var(--paper)]'
          : 'hover:bg-raised/48'
      } ${justCompleted ? 'task-complete-arrival' : ''}`}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, task)
      }}
    >
      <button
        type="button"
        aria-describedby={actionErrorId}
        onClick={(e) => onSelect(e, task, index)}
        className="grid h-14 w-full grid-cols-[minmax(220px,1fr)_82px_108px_116px] items-center text-left"
      >
        <span className="flex min-w-0 items-center gap-3 pe-4">
          <span className="grid h-8 w-10 shrink-0 place-items-center overflow-hidden rounded-[5px]">
            {thumbnail ? (
              <img
                data-task-artwork
                src={thumbnail}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className="t-skel-content media-thumbnail h-full w-full rounded-[5px] object-cover"
              />
            ) : (
              <TypeMark category={task.category} size="sm" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-normal leading-[1.25] tracking-[-0.008em] text-paper/94" title={task.filename || task.title}>
              {task.filename || task.title}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-fog">
              <span className="shrink-0">{CATEGORY_LABEL[task.category]}</span>
              <span aria-hidden>·</span>
              <span className="truncate" title={task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}>
                {task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}
              </span>
            </span>
          </span>
        </span>

        <StatusLabel task={task} justCompleted={justCompleted} />
        <span className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-mist">
          {live ? `${speed.value} ${speed.unit}` : task.fileSize > 0 ? formatBytes(task.fileSize) : '—'}
        </span>
        <span className="flex items-center gap-2 pe-3">
          <span className="w-9 text-end font-mono text-[11px] tabular-nums text-mist">{progressLabel}</span>
          <span className="h-0.5 min-w-0 flex-1 overflow-hidden bg-line">
            <span
              className={`block h-full w-full transition-transform duration-150 ease-linear ${failed ? 'bg-clay' : completed ? 'bg-sage' : 'bg-paper/72'}`}
              style={{ transform: `scaleX(${hasProgress ? Math.max(0.01, fraction) : 0})`, transformOrigin: 'left center' }}
            />
          </span>
        </span>
      </button>

      <div className="pointer-events-none absolute inset-y-px right-0 flex items-center gap-0.5 border-l border-line bg-raised px-2 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {completed ? (
          <>
            <Action title="快速预览 (Space)" onClick={() => void quickLook(filePath)}><Eye size={14} /></Action>
            <Action title={`在${FILE_MANAGER}中显示 (${COMMAND_KEY}+R)`} onClick={() => void revealFile(filePath)}><FolderOpen size={14} /></Action>
          </>
        ) : failed ? (
          <Action disabled={actionBusy} describedBy={actionErrorId} title="重试下载" onClick={() => onRestart(task)}><RotateCw size={14} /></Action>
        ) : (
          <Action disabled={actionBusy} describedBy={actionErrorId} title={live ? '暂停' : '继续'} onClick={() => onToggle(task)}>
            {live ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
          </Action>
        )}
        <Action title={copied ? '已复制链接' : '复制链接'} onClick={handleCopy}>
          {copied ? <Check size={14} className="text-sage" /> : <Copy size={14} />}
        </Action>
      </div>

    </div>
  )
}

function Action({
  title,
  onClick,
  children,
  disabled = false,
  describedBy
}: {
  title: string
  onClick: (event: React.MouseEvent) => void
  children: React.ReactNode
  disabled?: boolean
  describedBy?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
      data-cuelume-press="tick"
      className="grid size-7 place-items-center rounded-[6px] text-mist transition-[color,background-color] duration-100 hover:bg-line hover:text-paper disabled:cursor-wait disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function StatusLabel({ task, justCompleted = false }: { task: Task; justCompleted?: boolean }) {
  if (task.status === 'complete') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-sage">
        <Check size={11} strokeWidth={2} className={justCompleted ? 'task-complete-check' : ''} />
        完成
      </span>
    )
  }
  if (task.status === 'error') {
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-clay"><CircleAlert size={11} />失败</span>
  }
  if (task.status === 'downloading') {
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-paper/84"><ArrowDownToLine size={11} />下载中</span>
  }
  if (task.status === 'paused') {
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-mist"><Pause size={11} />已暂停</span>
  }
  if (task.status === 'incomplete') {
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-mist"><CircleAlert size={11} />未完成</span>
  }
  if (task.startAt) {
    const when = new Date(task.startAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-mist"><Clock3 size={11} />{when}</span>
  }
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-mist"><Clock3 size={11} />排队</span>
}

// Rows re-render only when their task data or selection state changes;
// callback props are read at event time, so identity changes are ignored.
export const TaskRow = memo(
  TaskRowImpl,
  (prev, next) =>
    prev.task === next.task &&
    prev.selected === next.selected &&
    prev.multiSelected === next.multiSelected &&
    prev.justCompleted === next.justCompleted &&
    prev.index === next.index &&
    prev.actionBusy === next.actionBusy &&
    prev.actionErrorId === next.actionErrorId
)
