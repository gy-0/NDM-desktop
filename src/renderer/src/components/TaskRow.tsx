import { Check, Copy, Eye, FolderOpen, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { formatBytes, formatEta, formatSpeed, fractionOf, remainingSeconds } from '../lib/format'
import { copyToClipboard, openFile, quickLook, remove, restartTask, revealFile, toggle } from '../lib/store'
import { STATUS_LABEL, type Task } from '../lib/types'
import { Connections } from './Connections'
import { TypeMark } from './Marks'

export function TaskRow({
  task,
  selected,
  multiSelected,
  index,
  onSelect,
  onContextMenu
}: {
  task: Task
  selected: boolean
  multiSelected?: boolean
  index: number
  onSelect: (e: React.MouseEvent) => void
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
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const isHighlighted = selected || multiSelected

  return (
    <div
      className={`group relative overflow-hidden bg-raised/40 transition-[border-radius,background-color,box-shadow] duration-200 ${
        isHighlighted
          ? 'bg-raised ring-1 ring-copper/50 shadow-[0_4px_16px_rgba(0,0,0,0.25)]'
          : 'hover:bg-raised/70'
      }`}
      style={{
        borderRadius: isHighlighted ? 14 : 20,
        animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${index * 30}ms both`
      }}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, task)
      }}
    >
      <button
        type="button"
        data-cuelume-press="whisper"
        onClick={onSelect}
        className="flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors duration-100"
      >
        <TypeMark category={task.category} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>

        {/* Quick action buttons on hover */}
        <div
          className="mr-1 hidden items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:flex group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          {completed ? (
            <>
              <button
                type="button"
                title="快速预览 (Space)"
                onClick={() => void quickLook(filePath)}
                className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
              >
                <Eye size={13} />
              </button>
              <button
                type="button"
                title="在访达中显示 (⌘R)"
                onClick={() => void revealFile(filePath)}
                className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
              >
                <FolderOpen size={13} />
              </button>
            </>
          ) : failed ? (
            <button
              type="button"
              title="重试下载"
              onClick={() => void restartTask(task.id)}
              className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-copper"
            >
              <RotateCw size={13} />
            </button>
          ) : (
            <button
              type="button"
              title={live ? '暂停' : '继续'}
              onClick={() => void toggle(task.id)}
              className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
            >
              {live ? <Pause size={13} /> : <Play size={13} />}
            </button>
          )}

          <button
            type="button"
            title={copied ? '已复制链接' : '复制链接'}
            onClick={handleCopy}
            className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
          >
            {copied ? <Check size={13} className="text-sage" /> : <Copy size={13} />}
          </button>

          <button
            type="button"
            title="删除任务"
            onClick={() => void remove(task.id, false)}
            className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-clay"
          >
            <Trash2 size={13} />
          </button>
        </div>

        <span className="text-[12.5px] tabular-nums text-mist">
          {live ? `${speed.value} ${speed.unit}` : formatBytes(task.fileSize)}
        </span>
        <Pill task={task} />
      </button>

      {/* Progress bar line for live or downloading items */}
      {live || (task.status === 'paused' && fraction > 0 && fraction < 1) ? (
        <div className="h-[2px] w-full bg-line">
          <div
            className="h-full bg-copper transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(2, Math.round(fraction * 100)))}%` }}
          />
        </div>
      ) : null}

      <div
        className="grid"
        style={{
          gridTemplateRows: selected && !multiSelected ? '1fr' : '0fr',
          opacity: selected && !multiSelected ? 1 : 0,
          transition: 'grid-template-rows 300ms cubic-bezier(0.23,1,0.32,1), opacity 300ms cubic-bezier(0.23,1,0.32,1)'
        }}
      >
        <div className="overflow-hidden">
          <div className="grid grid-cols-[24px_1fr] gap-2.5 px-3 pb-3 pt-1">
            <span aria-hidden className="mx-auto h-full w-px bg-line" />
            <div className="flex flex-col gap-1.5">
              <Detail label="来源" value={task.source ?? '—'} />
              <Detail
                label="进度"
                value={
                  live
                    ? `${Math.round(fraction * 100)}% · 剩余 ${formatEta(remainingSeconds(task))}`
                    : STATUS_LABEL[task.status]
                }
              />
              {failed && task.errorText ? <Detail label="原因" value={task.errorText} /> : null}
              {live || selected ? <Connections segments={task.segments} /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Pill({ task }: { task: Task }) {
  if (task.status === 'complete') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-sage/15 px-2 text-[11.5px] font-medium text-sage">完成</span>
  }
  if (task.status === 'error') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-clay/15 px-2 text-[11.5px] font-medium text-clay">失败</span>
  }
  if (task.status === 'downloading') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-copper/15 px-2 text-[11.5px] font-medium text-copper">下载中</span>
  }
  if (task.status === 'paused') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-line px-2 text-[11.5px] text-mist">已暂停</span>
  }
  return <span className="inline-flex h-[22px] items-center rounded-full bg-line px-2 text-[11.5px] text-mist">排队</span>
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[12px] text-mist">{label}</span>
      <span className="max-w-[280px] text-right font-mono text-[11.5px] leading-snug text-fog">{value}</span>
    </div>
  )
}
