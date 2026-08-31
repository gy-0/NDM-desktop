import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Clock3, Copy, Eye, FolderOpen, PackageOpen, Pause, Play, RotateCw, SlidersHorizontal, VolumeX } from 'lucide-react'
import { memo, useState } from 'react'
import { formatBytes, formatDownloadTime, formatSpeed, fractionOf, isDiskImageFile, isDistinctTitle } from '../lib/format'
import { copyToClipboard, openFile, quickLook, revealFile } from '../lib/store'
import { CATEGORY_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { COMMAND_KEY, FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
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
  const artwork = useTaskThumbnail(task)

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename
  const installedPath = artwork?.installedPath
  const actionPath = installedPath ?? filePath
  const diskImage = completed && !IS_WINDOWS && isDiskImageFile(filePath)
  const installsApp = diskImage && !installedPath

  const handleDoubleClick = (): void => {
    if (completed) {
      void openFile(actionPath)
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
  const showProgress = !completed && fraction > 0 && (live || task.status === 'paused' || task.status === 'incomplete')
  const progressLabel = `${Math.round(Math.min(1, fraction) * 100)}%`
  return (
    <div
      data-task-state={task.status}
      className={`group relative rounded-[9px] border border-transparent transition-[background-color,border-color,box-shadow] duration-150 ${
        isHighlighted
          ? 'border-line-strong/70 bg-raised/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.032)]'
          : 'hover:z-10 hover:border-line/65 hover:bg-raised/48 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.024)]'
      } ${justCompleted ? 'task-complete-arrival' : ''}`}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, task)
      }}
    >
      <button
        type="button"
        aria-pressed={isHighlighted}
        aria-describedby={actionErrorId}
        onClick={(e) => onSelect(e, task, index)}
        className="grid h-[68px] w-full grid-cols-[minmax(220px,1fr)_88px_112px_108px_124px] items-center text-left"
      >
        <span className="flex min-w-0 items-center gap-3.5 px-3 pe-5">
          {artwork ? (
            <span className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded-[6px] bg-ink/35 shadow-[inset_0_0_0_1px_var(--line)]">
              <img
                data-task-artwork
                src={artwork.source}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className={`t-skel-content media-thumbnail h-full w-full rounded-[6px] ${artwork.kind === 'icon' ? 'object-contain p-1' : 'object-cover'}`}
              />
            </span>
          ) : (
            <TypeMark category={task.category} size="sm" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-[14.5px] font-normal leading-[1.25] tracking-[-0.008em] text-paper/96" title={task.filename || task.title}>
              {task.filename || task.title}
            </span>
            <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-fog">
              <span className="shrink-0">{CATEGORY_LABEL[task.category]}</span>
              <span aria-hidden>·</span>
              <span className="truncate" title={task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}>
                {task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}
              </span>
            </span>
          </span>
        </span>

        <StatusLabel task={task} justCompleted={justCompleted} />
        <span className="whitespace-nowrap pe-5 text-right font-mono text-[12px] tabular-nums text-mist">
          {live
            ? `${speed.value} ${speed.unit}`
            : task.fileSize > 0
              ? formatBytes(task.fileSize)
              : task.completedBytes > 0
                ? `已下载 ${formatBytes(task.completedBytes)}`
                : '—'}
        </span>
        <span className="whitespace-nowrap pe-4 text-right text-[11.5px] tabular-nums text-mist" title={task.activityAt ? new Date(task.activityAt).toLocaleString('zh-CN') : undefined}>
          {formatDownloadTime(task.activityAt)}
        </span>
        <span className="flex items-center gap-2.5 pe-4 transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0">
          {showProgress ? (
            <>
              <span className="w-9 text-end font-mono text-[11.5px] tabular-nums text-mist">{progressLabel}</span>
              <span className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line/80">
                <span
                  className={`block h-full w-full rounded-[2px] transition-transform duration-[320ms] ease-linear ${failed ? 'bg-clay' : live ? 'bg-paper/76' : 'bg-mist'}`}
                  style={{ transform: `scaleX(${Math.max(0.01, fraction)})`, transformOrigin: 'left center' }}
                />
              </span>
            </>
          ) : null}
        </span>
      </button>

      <div className="pointer-events-none absolute inset-y-0 right-3 z-10 flex w-[142px] items-center justify-end gap-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        {completed ? (
          <>
            {installsApp ? <Action title="安装到“应用程序”" onClick={() => void openFile(filePath)}><PackageOpen size={14} /></Action> : null}
            {installedPath ? <Action title="打开已安装的应用" onClick={() => void openFile(installedPath)}><ArrowUpRight size={14} /></Action> : null}
            <Action title="快速预览 (Space)" onClick={() => void quickLook(actionPath)}><Eye size={14} /></Action>
            <Action title={`在${FILE_MANAGER}中显示 (${COMMAND_KEY}+R)`} onClick={() => void revealFile(actionPath)}><FolderOpen size={14} /></Action>
          </>
        ) : failed ? (
          <Action disabled={actionBusy} describedBy={actionErrorId} title="重试下载" onClick={() => onRestart(task)}><RotateCw size={14} /></Action>
        ) : (
          <>
            <Action title="调节连接数与限速" onClick={(event) => onSelect(event, task, index)}>
              <SlidersHorizontal size={14} />
            </Action>
            <Action disabled={actionBusy} describedBy={actionErrorId} title={live ? '暂停' : '继续'} onClick={() => onToggle(task)}>
              {live ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
            </Action>
          </>
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
      className="grid size-[30px] place-items-center rounded-[7px] text-mist transition-[color,background-color,box-shadow] duration-100 hover:bg-paper/[0.075] hover:text-paper hover:shadow-[inset_0_0_0_1px_var(--line)] focus-visible:bg-paper/[0.075] focus-visible:text-paper disabled:cursor-wait disabled:opacity-50"
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
        {task.deliveryNote ? (
          <span className="inline-flex text-copper" title={task.deliveryNote.title} aria-label={task.deliveryNote.title}>
            <VolumeX size={11} strokeWidth={1.8} />
          </span>
        ) : null}
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
