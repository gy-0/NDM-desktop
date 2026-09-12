import { Menu } from '@base-ui/react/menu'
import { CopyFeedbackIcon } from './ui/CopyFeedback'
import { taskNextAction } from '../lib/taskNextAction'
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Clock3, Eye, MoreHorizontal, FolderOpen, LoaderCircle, PackageOpen, Square, Pause, Play, RotateCw, SlidersHorizontal, VolumeX } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { taskDisplayTitle, formatBytes, formatDownloadTime, formatEta, formatSpeed, fractionOf, isDiskImageFile, isDistinctTitle, remainingSeconds } from '../lib/format'
import { installDiskImage } from '../lib/store'
import { CATEGORY_LABEL, STATUS_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { useCopyFeedback } from '../hooks/useCopyFeedback'
import { COMMAND_KEY, FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { TypeMark } from './Marks'
import type { InstallProgressState } from './TransferActivity'
import { SmoothProgressBar } from './SmoothProgressBar'

function TaskRowImpl({
  task,
  transferView = true,
  selected,
  multiSelected,
  justCompleted = false,
  index,
  onSelect,
  onFileDrag,
  onFileCommand,
  onContextMenu,
  actionBusy,
  actionBusyLabel,
  actionBlocked = false,
  actionErrorId,
  onToggle,
  onRestart,
  installProgress,
  columnTemplate
}: {
  task: Task
  transferView?: boolean
  selected: boolean
  multiSelected?: boolean
  justCompleted?: boolean
  index: number
  onSelect: (e: React.MouseEvent, task: Task, index: number) => void
  onFileCommand: (task: Task, action: 'open' | 'preview' | 'reveal') => void
  onFileDrag?: (task: Task) => void
  onContextMenu?: (e: React.MouseEvent, task: Task) => void
  actionBusy: boolean
  actionBusyLabel?: string
  actionBlocked?: boolean
  actionErrorId?: string
  onToggle: (task: Task) => void
  onRestart: (task: Task) => void
  installProgress?: InstallProgressState | null
  columnTemplate: string
}) {
  const fraction = fractionOf(task)
  const speed = formatSpeed(task.bytesPerSecond)
  const live = task.status === 'downloading'
  const recording = live && task.isLiveRecording
  const recordingTime = `已录 ${Math.floor((task.recordedDuration ?? 0) / 60)}:${String(Math.floor((task.recordedDuration ?? 0) % 60)).padStart(2, '0')}`
  const failed = task.status === 'error'
  const completed = task.status === 'complete'
  const [copied, copy, copyError] = useCopyFeedback()
  const [installLaunchBusy, setInstallLaunchBusy] = useState(false)
  const [installLaunchError, setInstallLaunchError] = useState('')
  const artwork = useTaskThumbnail(task)

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename
  const matchingInstall = installProgress?.path === filePath ? installProgress : null
  const installedPath = artwork?.installedPath ?? matchingInstall?.installedPath
  const diskImage = completed && !IS_WINDOWS && isDiskImageFile(filePath)
  const installsApp = diskImage && !installedPath
  const installInProgress = Boolean(matchingInstall && !['complete', 'failed', 'cancelled'].includes(matchingInstall.phase))
  const installing = installLaunchBusy || installInProgress
  const installError = installLaunchError || (matchingInstall?.phase === 'failed' ? matchingInstall.detail || '安装流程未完成' : '')
  const nextAction = taskNextAction(task)
  const primaryBusy = completed ? installing : actionBusy
  const primaryDisabled = primaryBusy || nextAction.disabled || (!completed && actionBlocked)
  const lifecycleBusyLabel = !completed && primaryBusy ? actionBusyLabel : undefined
  const primaryLabel = completed && installsApp
    ? installing ? '安装中' : installError ? '重试安装' : '安装'
    : primaryBusy ? actionBusyLabel ?? nextAction.busyLabel : nextAction.label

  useEffect(() => {
    setInstallLaunchBusy(false)
    setInstallLaunchError('')
  }, [filePath, installedPath])

  const startInstall = async (): Promise<void> => {
    if (installing) return
    setInstallLaunchBusy(true)
    setInstallLaunchError('')
    cue('tick')
    try {
      const result = await installDiskImage(filePath)
      if (result) {
        setInstallLaunchError(result)
        cue('droplet')
      }
    } catch {
      setInstallLaunchError('未能开始安装，请重试。')
      cue('droplet')
    } finally {
      setInstallLaunchBusy(false)
    }
  }

  const handlePrimaryAction = (event: React.MouseEvent): void => {
    event.stopPropagation()
    if (primaryDisabled) return
    if (completed && installsApp) void startInstall()
    else if (nextAction.kind === 'open') onFileCommand(task, 'open')
    else if (nextAction.kind === 'inspect') onSelect(event, task, index)
    else if (nextAction.kind === 'restart') onRestart(task)
    else onToggle(task)
  }

  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    copy(task.url)
  }

  const isHighlighted = selected || multiSelected
  const showProgress = !completed && !recording && fraction > 0 && (live || task.status === 'paused' || task.status === 'incomplete')
  const progressLabel = `${Math.round(Math.min(1, fraction) * 100)}%`
  const eta = live ? formatEta(remainingSeconds(task)) : null
  return (
    <div
      data-task-state={task.status}
      data-has-progress={showProgress || undefined}
      className={`group relative rounded-[9px] border border-transparent transition-[background-color,border-color,box-shadow] duration-150 ${
        isHighlighted
          ? 'border-line-strong/70 bg-raised/78 shadow-row'
          : 'hover:z-10 hover:border-line/65 hover:bg-raised/48 hover:shadow-row'
      } ${justCompleted ? 'task-complete-arrival' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, task)
      }}
    >
      <button
        type="button"
        data-task-select={task.id}
        aria-pressed={isHighlighted}
        aria-describedby={actionErrorId}
        onClick={(e) => onSelect(e, task, index)}
        onDoubleClick={(event) => {
          if (completed) onFileCommand(task, 'open')
          else handlePrimaryAction(event)
        }}
        draggable={completed}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (completed) onFileDrag?.(task)
        }}
        className="task-table-row grid h-[68px] w-full items-center text-left"
        style={{ gridTemplateColumns: columnTemplate }}
      >
        <span className="flex min-w-0 items-center gap-3.5 px-3 pe-5">
          <span
            data-task-artwork-slot
            className={`grid h-9 w-12 shrink-0 place-items-center ${artwork?.kind === 'preview' ? 'overflow-hidden rounded-[6px] bg-ink/35' : ''}`}
          >
            {artwork ? (
              <img
                data-task-artwork
                data-artwork-kind={artwork.kind}
                src={artwork.source}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className={`t-skel-content ${artwork.kind === 'icon' ? 'size-9 rounded-[9px] object-contain' : 'media-thumbnail h-9 w-12 rounded-[6px] object-cover'}`}
              />
            ) : (
              <TypeMark category={task.category} size="sm" />
            )}
          </span>
          <span className="min-w-0">
            <span data-task-title className="block truncate text-[14.5px] font-normal leading-[1.25] tracking-[-0.008em] text-paper/96" title={task.filename || task.title}>
              {taskDisplayTitle(task)}
            </span>
            <span data-task-description className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-fog">
              <span data-compact-status className="shrink-0">{task.awaitingDestination ? '待选目录' : recording ? '录制中' : STATUS_LABEL[task.status]} · </span>
              <span className="shrink-0">{CATEGORY_LABEL[task.category]}</span>
              <span aria-hidden>·</span>
              <span className="truncate" title={task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}>
                {task.diagnostic?.summary || (isDistinctTitle(task.title, task.filename) ? task.title : task.source)}
              </span>
            </span>
            {live ? (
              <span data-transfer-metadata className="mt-1.5 items-center gap-1.5 whitespace-nowrap text-[11.5px] tabular-nums text-fog">
                <span data-transfer-speed className="font-mono" title={recording ? '已保存大小' : '下载速度'}>{recording ? formatBytes(task.completedBytes) : `${speed.value} ${speed.unit}`}</span>
                <span data-transfer-divider aria-hidden>·</span>
                <span data-transfer-eta title={recording ? '已录制时长' : '预计剩余时间'}>{recording ? recordingTime : eta === '—' ? '计算中' : `剩余 ${eta}`}</span>
              </span>
            ) : null}
          </span>
        </span>

        <span className={`flex min-w-0 items-center`}>
          <StatusLabel
            task={task}
            justCompleted={justCompleted}
            installsApp={installsApp}
            installedPath={installedPath}
            installing={installing}
            installError={installError}
          />
        </span>
        <span className={`whitespace-nowrap pe-5 text-right font-mono text-meta tabular-nums text-mist`}>
          {recording ? `已保存 ${formatBytes(task.completedBytes)}` : live && transferView
            ? `${speed.value} ${speed.unit}`
            : task.fileSize > 0
              ? formatBytes(task.fileSize)
              : task.completedBytes > 0
                ? `已下载 ${formatBytes(task.completedBytes)}`
                : '—'}
        </span>
        <span
          data-task-time
          className={`whitespace-nowrap pe-4 text-right text-[11.5px] tabular-nums text-mist`}
          title={recording ? '已录制时长' : live ? '预计剩余时间' : task.activityAt ? new Date(task.activityAt).toLocaleString('zh-CN') : undefined}
        >
          {recording ? recordingTime : live && transferView ? (eta === '—' ? '计算中' : `剩余 ${eta}`) : formatDownloadTime(task.activityAt)}
        </span>
        <span className={`task-row-progress flex items-center gap-2.5 pe-4`}>
          {showProgress ? (
            <>
              <span className="w-9 text-end font-mono text-meta tabular-nums text-mist">{progressLabel}</span>
              <SmoothProgressBar
                fraction={fraction}
                active={live}
                fillClassName={failed ? 'bg-clay' : live ? 'bg-paper/76' : 'bg-mist'}
                trackClassName={live ? 'task-progress-warp' : ''}
              />
            </>
          ) : null}
        </span>
      </button>

      <div data-row-actions onDoubleClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          data-task-primary-action={nextAction.kind}
          data-completion-action={completed ? installsApp ? 'install' : 'open' : undefined}
          data-install-action={installsApp ? '' : undefined}
          data-attention={failed || task.awaitingDestination || Boolean(installError) || undefined}
          aria-label={lifecycleBusyLabel ?? (completed && installsApp ? installError ? '重试安装' : '安装到“应用程序”' : nextAction.ariaLabel)}
          aria-busy={primaryBusy || undefined}
          aria-describedby={actionErrorId}
          title={lifecycleBusyLabel ?? (completed && installsApp ? installError || '安装到“应用程序”' : nextAction.ariaLabel)}
          disabled={primaryDisabled}
          onClick={handlePrimaryAction}
          data-cuelume-press="tick"
          className="task-primary-action"
        >
          {primaryBusy || nextAction.disabled ? <LoaderCircle size={13} className="animate-spin" aria-hidden />
            : completed ? installsApp ? <PackageOpen size={13} aria-hidden /> : <ArrowUpRight size={13} aria-hidden />
            : nextAction.kind === 'inspect' ? <CircleAlert size={13} aria-hidden />
            : nextAction.kind === 'restart' ? <RotateCw size={13} aria-hidden />
            : task.awaitingDestination ? <FolderOpen size={13} aria-hidden />
            : recording ? <Square size={13} aria-hidden />
            : live || task.status === 'waiting' ? <Pause size={13} aria-hidden />
            : <Play size={13} aria-hidden />}
          <span>{primaryLabel}</span>
        </button>
        <Menu.Root>
          <Menu.Trigger className="task-more-action" aria-label={`更多操作：${taskDisplayTitle(task)}`} title="更多操作" data-cuelume-press="tick">
            <MoreHorizontal size={16} aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={5} collisionPadding={8} className="z-[70] outline-none">
              <Menu.Popup className="task-actions-menu" aria-label={`${taskDisplayTitle(task)} 的更多操作`}>
                <Menu.Group>
                  <Menu.GroupLabel className="task-actions-menu-title">{taskDisplayTitle(task)}</Menu.GroupLabel>
                  <Menu.Item className="task-actions-menu-item" onClick={(event) => onSelect(event, task, index)}>
                    <SlidersHorizontal size={14} aria-hidden /><span>任务详情</span>
                  </Menu.Item>
                  {completed ? <>
                    <Menu.Item className="task-actions-menu-item" onClick={() => onFileCommand(task, 'preview')}>
                      <Eye size={14} aria-hidden /><span>快速预览</span><kbd>Space</kbd>
                    </Menu.Item>
                    <Menu.Item className="task-actions-menu-item" onClick={() => onFileCommand(task, 'reveal')}>
                      <FolderOpen size={14} aria-hidden /><span>在{FILE_MANAGER}中显示</span><kbd>{COMMAND_KEY} R</kbd>
                    </Menu.Item>
                  </> : null}
                  <Menu.Item className="task-actions-menu-item" closeOnClick={false} onClick={handleCopy}>
                    <CopyFeedbackIcon copied={copied} size={14} /><span aria-live="polite">{copyError || (copied ? '已复制链接' : '复制下载链接')}</span>
                  </Menu.Item>
                </Menu.Group>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

    </div>
  )
}

function StatusLabel({
  task,
  justCompleted = false,
  installsApp = false,
  installedPath,
  installing = false,
  installError = ''
}: {
  task: Task
  justCompleted?: boolean
  installsApp?: boolean
  installedPath?: string
  installing?: boolean
  installError?: string
}) {
  if (task.awaitingDestination) return <span className="text-[11.5px] text-fog">待选目录</span>
  if (task.status === 'complete') {
    if (installError) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-clay" title={installError}><CircleAlert size={11} />安装失败</span>
    }
    if (installedPath) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-sage"><Check size={11} strokeWidth={2} />已安装</span>
    }
    if (installing) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-paper/84"><LoaderCircle size={11} className="animate-spin" />安装中</span>
    }
    if (installsApp) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fog"><PackageOpen size={11} strokeWidth={1.8} />可安装</span>
    }
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
    return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-paper/84"><ArrowDownToLine size={11} />{task.isLiveRecording ? task.phase === 'merging' ? '正在保存' : '录制中' : '下载中'}</span>
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
    prev.actionBusyLabel === next.actionBusyLabel &&
    prev.actionBlocked === next.actionBlocked &&
    prev.actionErrorId === next.actionErrorId &&
    prev.installProgress === next.installProgress &&
    prev.columnTemplate === next.columnTemplate &&
    prev.transferView === next.transferView
)
