import { ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleAlert, Eye, Files, FolderOpen, PackageOpen, RotateCw, SlidersHorizontal, Square } from 'lucide-react'
import { memo, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { formatBytes, formatSpeed, fractionOf, isDiskImageFile, taskDisplayTitle } from '../lib/format'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { cue } from '../lib/sound'
import { installDiskImage } from '../lib/store'
import { taskNextAction } from '../lib/taskNextAction'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type Task } from '../lib/types'
import { TypeMark } from './Marks'
import type { InstallProgressState } from './TransferActivity'
import { TransferActionIcon } from './ui/TransferActionIcon'
import './ui/task-gallery.css'

const PAGE_SIZE = 48

export interface TaskGalleryProps {
  tasks: Task[]
  selectedIds: Set<number>
  onSelect: (task: Task, event?: MouseEvent) => void
  onFileCommand: (task: Task, action: 'open' | 'preview' | 'reveal') => void
  onToggle: (task: Task) => void
  onRestart: (task: Task) => void
  actionBlocked?: boolean
  busyTaskIds?: Set<number>
  installProgress?: InstallProgressState | null
  empty?: ReactNode
}

/** A bounded file overview: only the current page mounts artwork requests. */
export function TaskGallery({ tasks, selectedIds, onSelect, onFileCommand, onToggle, onRestart, actionBlocked = false, busyTaskIds, installProgress, empty }: TaskGalleryProps) {
  const [page, setPage] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const focusNextPage = useRef(false)
  const pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const first = currentPage * PAGE_SIZE
  const pageTasks = tasks.slice(first, first + PAGE_SIZE)

  useLayoutEffect(() => { setPage(value => Math.min(value, pageCount - 1)) }, [pageCount])
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    if (focusNextPage.current) {
      focusNextPage.current = false
      gridRef.current?.querySelector<HTMLButtonElement>('[data-gallery-select]')?.focus({ preventScroll: true })
    }
  }, [currentPage])

  const changePage = (next: number, focusCard = true): void => {
    focusNextPage.current = focusCard
    setPage(Math.max(0, Math.min(pageCount - 1, next)))
  }

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const grid = gridRef.current
    if (!grid || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      changePage(currentPage + (event.key === 'PageDown' ? 1 : -1))
      return
    }
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1
    const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? pageTasks.length - 1 : Math.min(pageTasks.length - 1, Math.max(0, index + offset))
    grid.querySelectorAll<HTMLButtonElement>('[data-gallery-select]')[next]?.focus()
  }

  if (!tasks.length) return <section data-task-gallery className="task-gallery" aria-label="文件卡片">
    {empty ?? <div className="task-gallery-empty"><Files size={36} strokeWidth={1.2} aria-hidden /><p>这里还没有文件</p><span>添加下载后，在这里查看你的文件。</span></div>}
  </section>

  return <section data-task-gallery className="task-gallery" aria-label="文件卡片">
    <div ref={scrollRef} className="task-gallery-scroll scroll-quiet">
      <div className="task-gallery-heading">
        <p><strong>{tasks.length.toLocaleString()} 个文件</strong></p>
        <p className="task-gallery-hint">选择查看详情 · 空格快速预览</p>
      </div>
      <div ref={gridRef} className="task-gallery-grid" role="list" aria-label="文件卡片列表">
        {pageTasks.map((task, index) => <GalleryCard
          key={task.id}
          task={task}
          selected={selectedIds.has(task.id)}
          busy={busyTaskIds?.has(task.id) ?? false}
          actionBlocked={actionBlocked}
          installProgress={installProgress}
          position={first + index + 1}
          total={tasks.length}
          onSelect={onSelect}
          onFileCommand={onFileCommand}
          onToggle={onToggle}
          onRestart={onRestart}
          onNavigate={event => navigate(event, index)}
        />)}
      </div>
    </div>
    {pageCount > 1 ? <nav className="task-gallery-pagination" aria-label="文件卡片分页">
      <span aria-live="polite" aria-atomic="true">{first + 1}–{first + pageTasks.length} / {tasks.length.toLocaleString()}</span>
      <div className="task-gallery-pagination-controls">
        <button type="button" aria-label="上一页文件" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={15} aria-hidden /></button>
        <select aria-label="卡片页码" value={currentPage} onChange={event => changePage(Number(event.target.value), false)}>
          {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>第 {index + 1} / {pageCount} 页</option>)}
        </select>
        <button type="button" aria-label="下一页文件" disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}><ChevronRight size={15} aria-hidden /></button>
      </div>
    </nav> : null}
  </section>
}

const GalleryCard = memo(function GalleryCard({ task, selected, busy, actionBlocked, installProgress, position, total, onSelect, onFileCommand, onToggle, onRestart, onNavigate }: {
  task: Task
  selected: boolean
  busy: boolean
  actionBlocked: boolean
  installProgress?: InstallProgressState | null
  position: number
  total: number
  onSelect: TaskGalleryProps['onSelect']
  onFileCommand: TaskGalleryProps['onFileCommand']
  onToggle: TaskGalleryProps['onToggle']
  onRestart: TaskGalleryProps['onRestart']
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const artwork = useTaskThumbnail(task)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [installLaunchBusy, setInstallLaunchBusy] = useState(false)
  const [installLaunchError, setInstallLaunchError] = useState('')
  const installPending = useRef(false)
  const installGeneration = useRef(0)
  const id = useId()
  const title = taskDisplayTitle(task)
  const complete = task.status === 'complete'
  const recording = Boolean(task.isLiveRecording && task.status === 'downloading')
  const next = taskNextAction(task)
  const filePath = task.folderPath ? `${task.folderPath}${task.folderPath.endsWith('/') ? '' : '/'}${task.filename}` : task.filename
  const matchingInstall = installProgress?.path === filePath ? installProgress : null
  const installedPath = artwork?.installedPath ?? matchingInstall?.installedPath
  const diskImage = complete && !IS_WINDOWS && isDiskImageFile(filePath)
  const installsApp = diskImage && !installedPath
  const installInProgress = Boolean(matchingInstall && !['complete', 'failed', 'cancelled'].includes(matchingInstall.phase))
  const installing = installLaunchBusy || installInProgress
  const installError = installLaunchError || (matchingInstall?.phase === 'failed' ? matchingInstall.detail || '安装流程未完成' : '')
  // File delivery is independent of an unrelated task's pause/delete receipt.
  const primaryBusy = complete ? installing : busy
  const blocked = primaryBusy || next.disabled || (!complete && actionBlocked)
  const primaryLabel = installsApp ? installing ? '安装中' : installError ? '重试安装' : '安装' : primaryBusy ? next.busyLabel : next.label
  const primaryAriaLabel = installsApp ? installing ? '正在安装' : installError ? '重试安装' : '安装到“应用程序”' : primaryBusy ? next.busyLabel : next.ariaLabel
  const fraction = fractionOf(task)
  const knownProgress = !complete && !recording && (task.fileSize > 0 || task.progressFraction != null && Number.isFinite(task.progressFraction))
  const progress = `${Math.round(fraction * 100)}%`
  const extension = fileExtension(task.filename)
  const visibleArtwork = artwork?.source !== failedSource ? artwork : null
  const status = diskImage ? installError ? '安装失败' : installing ? '安装中' : installedPath ? '已安装' : '可安装'
    : task.awaitingDestination ? '待选保存目录'
    : recording ? task.phase === 'merging' ? '正在保存录制' : '正在录制'
      : task.status === 'downloading' && task.phase && task.phase !== 'transferring' ? PHASE_LABEL[task.phase]
        : STATUS_LABEL[task.status]
  const speed = formatSpeed(task.bytesPerSecond)
  const size = task.fileSize > 0 ? formatBytes(task.fileSize) : task.completedBytes > 0 ? `已下载 ${formatBytes(task.completedBytes)}` : '大小待定'
  const detail = recording ? `已保存 ${formatBytes(task.completedBytes)}`
    : task.status === 'downloading' ? `${knownProgress ? `${progress} · ` : ''}${speed.value} ${speed.unit}`
      : !complete && knownProgress ? progress : ''

  useLayoutEffect(() => {
    installGeneration.current++
    installPending.current = false
    setInstallLaunchBusy(false)
    setInstallLaunchError('')
    return () => { installGeneration.current++; installPending.current = false }
  }, [filePath, installedPath])

  const startInstall = async (): Promise<void> => {
    if (installing || installPending.current) return
    installPending.current = true
    const generation = ++installGeneration.current
    setInstallLaunchBusy(true)
    setInstallLaunchError('')
    cue('tick')
    try {
      const error = await installDiskImage(filePath)
      if (generation !== installGeneration.current) return
      if (error) { setInstallLaunchError(error); cue('droplet') }
    } catch {
      if (generation === installGeneration.current) { setInstallLaunchError('未能开始安装，请重试。'); cue('droplet') }
    } finally {
      if (generation === installGeneration.current) { installPending.current = false; setInstallLaunchBusy(false) }
    }
  }

  const runPrimary = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (blocked) return
    if (installsApp) void startInstall()
    else if (next.kind === 'open') onFileCommand(task, 'open')
    else if (next.kind === 'inspect') onSelect(task, event)
    else if (next.kind === 'restart') onRestart(task)
    else onToggle(task)
  }

  return <article className="gallery-card" role="listitem" aria-posinset={position} aria-setsize={total}
    data-gallery-card={task.id} data-task-state={task.status} data-selected={selected}
    data-gallery-install-state={diskImage ? installError ? 'failed' : installing ? 'installing' : installedPath ? 'installed' : 'ready' : undefined}>
    <button type="button" className="gallery-card-select" data-gallery-select={task.id} data-task-select={task.id}
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-meta ${id}-status`} aria-pressed={selected}
      onClick={event => onSelect(task, event)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.stopPropagation(); if (event.repeat) event.preventDefault() }
        else if (event.key === ' ' && !event.metaKey && !event.ctrlKey) {
          event.stopPropagation()
          if (complete) {
            event.preventDefault()
            if (!event.repeat) onFileCommand(task, 'preview')
          }
        } else onNavigate(event)
      }} />
    <div className="gallery-card-preview">
      <div className="gallery-file-figure" aria-hidden>
        <div className="gallery-file-paper"><TypeMark category={task.category} size="lg" /><span className="gallery-file-extension">{extension || 'FILE'}</span><i className="gallery-file-rule" /></div>
      </div>
      {visibleArtwork ? <img className="gallery-card-artwork" src={visibleArtwork.source} alt="" aria-hidden draggable={false} loading="lazy" decoding="async"
        data-artwork-kind={visibleArtwork.kind} data-loaded={loadedSource === visibleArtwork.source}
        onLoad={() => setLoadedSource(visibleArtwork.source)} onError={() => setFailedSource(visibleArtwork.source)} /> : null}
      <span className="gallery-card-type" aria-hidden>{extension || CATEGORY_LABEL[task.category]}</span>
      <span className="gallery-card-selected" aria-hidden><Check size={13} strokeWidth={2.2} /></span>
      {complete ? <div className="gallery-preview-actions">
        <button type="button" data-gallery-preview aria-label={`快速预览：${title}`} onClick={() => onFileCommand(task, 'preview')}><Eye size={14} aria-hidden />快速预览</button>
        <button type="button" data-gallery-reveal aria-label={`在${FILE_MANAGER}中显示：${title}`} title={`在${FILE_MANAGER}中显示`} onClick={() => onFileCommand(task, 'reveal')}><FolderOpen size={14} aria-hidden /></button>
      </div> : <div className="gallery-preview-actions">
        <button type="button" aria-label={`查看任务详情：${title}`} onClick={event => onSelect(task, event)}><SlidersHorizontal size={14} aria-hidden />任务详情</button>
      </div>}
    </div>
    <div className="gallery-card-info">
      <p id={`${id}-title`} className="gallery-card-title" data-task-title title={task.filename || title}>{title}</p>
      <p id={`${id}-meta`} className="gallery-card-meta"><span>{CATEGORY_LABEL[task.category]}</span><span aria-hidden>·</span><span title={size}>{size}</span></p>
      <div className="gallery-card-footer">
        <span id={`${id}-status`} className="gallery-card-status" title={[status, detail, task.diagnostic?.summary].filter(Boolean).join(' · ')}>
          {installError || task.status === 'error' ? <CircleAlert size={12} aria-hidden /> : diskImage && !installedPath ? <PackageOpen size={12} aria-hidden /> : complete ? <Check size={12} aria-hidden /> : task.status === 'downloading' ? <ArrowDownToLine size={12} aria-hidden /> : null}
          <span className="gallery-card-status-copy"><span>{status}</span>{detail ? <small>{detail}</small> : null}</span>
        </span>
        <button type="button" className="gallery-card-primary" data-gallery-primary={installsApp ? 'install' : next.kind} aria-label={primaryAriaLabel}
          aria-describedby={installError ? `${id}-install-error` : undefined}
          aria-busy={primaryBusy || undefined} disabled={blocked} onClick={runPrimary}>
          {primaryBusy ? <TransferActionIcon state="pending" size={13} />
            : installsApp ? <PackageOpen size={13} aria-hidden />
              : next.kind === 'open' ? <ArrowUpRight size={13} aria-hidden />
              : next.kind === 'restart' ? <RotateCw size={13} aria-hidden />
                : next.kind === 'inspect' ? <CircleAlert size={13} aria-hidden />
                  : task.awaitingDestination ? <FolderOpen size={13} aria-hidden />
                    : recording ? <Square size={12} aria-hidden />
                      : <TransferActionIcon state={task.status === 'downloading' || task.status === 'waiting' ? 'pause' : 'play'} size={13} />}
          <span>{primaryLabel}</span>
        </button>
      </div>
      {installError ? <p id={`${id}-install-error`} className="gallery-card-install-error" data-gallery-install-error role="status">{installError}</p> : null}
    </div>
    {knownProgress ? <div className="gallery-card-progress" data-gallery-progress role="progressbar" aria-label={`${title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
      <span style={{ transform: `scaleX(${fraction})` }} />
    </div> : null}
  </article>
})

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()
}
