import { Check, Copy, Eye, FolderOpen, Pause, Play, RotateCw } from 'lucide-react'
import { memo, useState } from 'react'
import { formatBytes, formatSpeed, fractionOf } from '../lib/format'
import { copyToClipboard, openFile, quickLook, restartTask, revealFile, toggle } from '../lib/store'
import { CATEGORY_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { TypeMark } from './Marks'

function TaskRowImpl({
  task,
  selected,
  multiSelected,
  justCompleted = false,
  index,
  onSelect,
  onContextMenu
}: {
  task: Task
  selected: boolean
  multiSelected?: boolean
  justCompleted?: boolean
  index: number
  onSelect: (e: React.MouseEvent, task: Task, index: number) => void
  onContextMenu?: (e: React.MouseEvent, task: Task) => void
}) {
  const fraction = fractionOf(task)
  const speed = formatSpeed(task.bytesPerSecond)
  const live = task.status === 'downloading'
  const failed = task.status === 'error'
  const completed = task.status === 'complete'
  const [copied, setCopied] = useState(false)

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename

  const handleDoubleClick = (): void => {
    if (completed) {
      void openFile(filePath)
    } else {
      void toggle(task.id)
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

  return (
    <div
      className={`group relative overflow-hidden rounded-[13px] bg-raised/30 transition-[background-color,box-shadow] duration-100 ${
        isHighlighted
          ? 'bg-raised shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_42%,transparent),0_6px_20px_rgba(0,0,0,0.12)]'
          : 'hover:bg-raised/65'
      } ${justCompleted ? 'task-complete-arrival' : ''}`}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, task)
      }}
    >
      <button
        type="button"
        onClick={(e) => onSelect(e, task, index)}
        className="grid h-[58px] w-full grid-cols-[36px_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 text-left"
      >
        <TypeMark category={task.category} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-normal leading-[1.2] tracking-[-0.008em] text-paper/92" title={task.filename || task.title}>
            {task.filename || task.title}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px] text-fog">
            <span className="shrink-0">{CATEGORY_LABEL[task.category]}</span>
            <span aria-hidden>·</span>
            <span className="truncate" title={task.title || task.source}>{task.title !== task.filename ? task.title : task.source}</span>
          </span>
        </span>

        <span className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-mist">
          {live ? `${speed.value} ${speed.unit}` : formatBytes(task.fileSize)}
        </span>
        <Pill task={task} justCompleted={justCompleted} />
      </button>

      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 rounded-[9px] bg-raised/95 px-1.5 opacity-0 shadow-[-12px_0_18px_var(--raised)] transition-[opacity] duration-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {completed ? (
          <>
            <Action title="快速预览 (Space)" onClick={() => void quickLook(filePath)}><Eye size={14} /></Action>
            <Action title="在访达中显示 (⌘R)" onClick={() => void revealFile(filePath)}><FolderOpen size={14} /></Action>
          </>
        ) : failed ? (
          <Action title="重试下载" onClick={() => void restartTask(task.id)}><RotateCw size={14} /></Action>
        ) : (
          <Action title={live ? '暂停' : '继续'} onClick={() => void toggle(task.id)}>
            {live ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
          </Action>
        )}
        <Action title={copied ? '已复制链接' : '复制链接'} onClick={handleCopy}>
          {copied ? <Check size={14} className="text-sage" /> : <Copy size={14} />}
        </Action>
      </div>

      {live || (task.status === 'paused' && fraction > 0 && fraction < 1) ? (
        <div className="absolute inset-x-3 bottom-0 h-px overflow-hidden rounded-full bg-line">
          <div
            className={`h-full w-full rounded-full transition-[transform] duration-150 ease-linear ${live ? 'bg-copper' : 'bg-mist'}`}
            style={{ transform: `scaleX(${Math.max(0.02, fraction)})`, transformOrigin: 'left center' }}
          />
        </div>
      ) : null}
    </div>
  )
}

function Action({ title, onClick, children }: { title: string; onClick: (event: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-[7px] text-mist transition-[color,background-color,scale] duration-100 hover:bg-line hover:text-paper active:scale-[0.96]"
    >
      {children}
    </button>
  )
}

function Pill({ task, justCompleted = false }: { task: Task; justCompleted?: boolean }) {
  if (task.status === 'complete') {
    return (
      <span className="inline-flex w-[54px] items-center justify-end gap-1 whitespace-nowrap text-[10.5px] text-sage">
        <Check size={11} strokeWidth={2} className={justCompleted ? 'task-complete-check' : ''} />
        完成
      </span>
    )
  }
  if (task.status === 'error') {
    return <span className="inline-flex w-[54px] items-center justify-end gap-1 whitespace-nowrap text-[10.5px] text-clay"><span className="size-1.5 rounded-full bg-clay" />失败</span>
  }
  if (task.status === 'downloading') {
    return <span className="inline-flex w-[54px] items-center justify-end gap-1 whitespace-nowrap text-[10.5px] text-copper"><span className="size-1.5 rounded-full bg-copper" />下载中</span>
  }
  if (task.status === 'paused') {
    return <span className="inline-flex w-[54px] items-center justify-end whitespace-nowrap text-[10.5px] text-mist">已暂停</span>
  }
  return <span className="inline-flex w-[54px] items-center justify-end whitespace-nowrap text-[10.5px] text-mist">排队</span>
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
    prev.index === next.index
)
