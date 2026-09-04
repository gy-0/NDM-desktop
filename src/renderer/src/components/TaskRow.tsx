import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Clock3, Copy, Eye, FolderOpen, LoaderCircle, PackageOpen, Pause, Play, RotateCw, SlidersHorizontal, VolumeX } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useState } from 'react'
import { formatBytes, formatDownloadTime, formatEta, formatSpeed, fractionOf, isDiskImageFile, isDistinctTitle, remainingSeconds } from '../lib/format'
import { copyToClipboard, openFile, quickLook, revealFile } from '../lib/store'
import { CATEGORY_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { COMMAND_KEY, FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { TypeMark } from './Marks'
import type { InstallProgressState } from './TransferActivity'
import { SmoothProgressBar } from './SmoothProgressBar'

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
  onRestart,
  installProgress,
  columnTemplate
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
  installProgress?: InstallProgressState | null
  columnTemplate: string
}) {
  const fraction = fractionOf(task)
  const speed = formatSpeed(task.bytesPerSecond)
  const live = task.status === 'downloading'
  const failed = task.status === 'error'
  const completed = task.status === 'complete'
  const [copied, setCopied] = useState(false)
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
  const actionPath = installedPath ?? filePath
  const diskImage = completed && !IS_WINDOWS && isDiskImageFile(filePath)
  const installsApp = diskImage && !installedPath
  const hasCompletionAction = installsApp || Boolean(installedPath)
  const installInProgress = Boolean(matchingInstall && !['complete', 'failed', 'cancelled'].includes(matchingInstall.phase))
  const installing = installLaunchBusy || installInProgress
  const installError = installLaunchError || (matchingInstall?.phase === 'failed' ? matchingInstall.detail || '安装流程未完成' : '')

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
      const result = await openFile(filePath)
      if (result) {
        setInstallLaunchError(result)
        cue('droplet')
      }
    } catch {
      setInstallLaunchError('安装没有开始，请重试。')
      cue('droplet')
    } finally {
      setInstallLaunchBusy(false)
    }
  }

  const handleDoubleClick = (): void => {
    if (completed) {
      if (installsApp) void startInstall()
      else void openFile(actionPath)
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
  const eta = live ? formatEta(remainingSeconds(task)) : null
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
        className="grid h-[68px] w-full items-center text-left"
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

        <StatusLabel
          task={task}
          justCompleted={justCompleted}
          installsApp={installsApp}
          installedPath={installedPath}
          installing={installing}
          installError={installError}
        />
        <span className="whitespace-nowrap pe-5 text-right font-mono text-[12px] tabular-nums text-mist">
          {live
            ? `${speed.value} ${speed.unit}`
            : task.fileSize > 0
              ? formatBytes(task.fileSize)
              : task.completedBytes > 0
                ? `已下载 ${formatBytes(task.completedBytes)}`
                : '—'}
        </span>
        <span
          data-task-time
          className="whitespace-nowrap pe-4 text-right text-[11.5px] tabular-nums text-mist"
          title={live ? '预计剩余时间' : task.activityAt ? new Date(task.activityAt).toLocaleString('zh-CN') : undefined}
        >
          {live ? (eta === '—' ? '计算中' : `剩余 ${eta}`) : formatDownloadTime(task.activityAt)}
        </span>
        <span className="flex items-center gap-2.5 pe-4 transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0">
          {showProgress ? (
            <>
              <span className="w-9 text-end font-mono text-[11.5px] tabular-nums text-mist">{progressLabel}</span>
              <SmoothProgressBar
                fraction={fraction}
                active={live}
                fillClassName={failed ? 'bg-clay' : live ? 'bg-paper/76' : 'bg-mist'}
              />
            </>
          ) : null}
        </span>
      </button>

      <div className={`absolute inset-y-0 right-3 z-10 flex w-[142px] items-center justify-end gap-1 transition-opacity duration-100 ${
        hasCompletionAction
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
      }`}>
        {completed ? (
          <>
            {hasCompletionAction ? (
              <PrimaryAction
                kind={installedPath ? 'open' : 'install'}
                title={installedPath ? '打开已安装的应用' : installError ? `${installError}，重试安装` : '安装到“应用程序”'}
                disabled={!installedPath && installing}
                failed={!installedPath && Boolean(installError)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (installedPath) void openFile(installedPath)
                  else void startInstall()
                }}
              >
                <PrimaryActionIcon state={installedPath ? 'open' : installing ? 'installing' : installError ? 'retry' : 'install'} />
                {installedPath ? '打开' : installing ? '安装中' : installError ? '重试' : '安装'}
              </PrimaryAction>
            ) : null}
            {!hasCompletionAction ? <Action title="快速预览 (Space)" onClick={() => void quickLook(actionPath)}><Eye size={14} /></Action> : null}
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

function PrimaryAction({
  kind,
  title,
  onClick,
  children,
  disabled = false,
  failed = false
}: {
  kind: 'install' | 'open'
  title: string
  onClick: (event: React.MouseEvent) => void
  children: React.ReactNode
  disabled?: boolean
  failed?: boolean
}) {
  return (
    <button
      type="button"
      data-completion-action={kind}
      data-install-action={kind === 'install' ? '' : undefined}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      data-cuelume-press="tick"
      className={`inline-flex h-[30px] items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-medium transition-[background-color,color,scale,opacity] duration-100 active:scale-[0.96] disabled:cursor-wait disabled:opacity-60 ${
        failed
          ? 'bg-clay/14 text-clay hover:bg-clay/20'
          : 'bg-accent text-on-accent hover:bg-paper'
      }`}
    >
      {children}
    </button>
  )
}

function PrimaryActionIcon({ state }: { state: 'install' | 'installing' | 'retry' | 'open' }) {
  return (
    <span className="relative grid size-[13px] shrink-0 place-items-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="absolute inset-0 grid place-items-center"
        >
          {state === 'installing' ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {state === 'retry' ? <RotateCw size={13} /> : null}
          {state === 'install' ? <PackageOpen size={13} /> : null}
          {state === 'open' ? <ArrowUpRight size={13} /> : null}
        </motion.span>
      </AnimatePresence>
    </span>
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
      aria-label={title}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      data-cuelume-press="tick"
      className="group/action relative grid size-[30px] place-items-center rounded-[7px] text-mist transition-[color,background-color,box-shadow] duration-100 hover:bg-paper/[0.075] hover:text-paper hover:shadow-[inset_0_0_0_1px_var(--line)] focus-visible:bg-paper/[0.075] focus-visible:text-paper disabled:cursor-wait disabled:opacity-50"
    >
      {children}
      <span className="pointer-events-none absolute end-0 top-[35px] z-30 whitespace-nowrap rounded-[6px] bg-paper px-2 py-1 text-[11px] font-medium text-ink opacity-0 shadow-[0_8px_24px_-10px_rgb(0_0_0/0.65)] transition-opacity duration-100 group-hover/action:opacity-100 group-focus-visible/action:opacity-100">
        {title}
      </span>
    </button>
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
  if (task.status === 'complete') {
    if (installError) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-clay" title={installError}><CircleAlert size={11} />安装失败</span>
    }
    if (installedPath) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-sage"><Check size={11} strokeWidth={2} />已安装</span>
    }
    if (installing) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-copper"><LoaderCircle size={11} className="animate-spin" />安装中</span>
    }
    if (installsApp) {
      return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-copper"><PackageOpen size={11} strokeWidth={1.8} />可安装</span>
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
    prev.actionErrorId === next.actionErrorId &&
    prev.installProgress === next.installProgress &&
    prev.columnTemplate === next.columnTemplate
)
