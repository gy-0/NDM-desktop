import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Eye, Files, FolderOpen, PackageOpen, RotateCw, SlidersHorizontal, Square } from 'lucide-react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
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

const CARD_HEIGHT = 242
const CARD_GAP = 14
const CARD_MIN_WIDTH = 174
const CARD_MAX_WIDTH = 220
const CARD_STEP = CARD_HEIGHT + CARD_GAP
const CARD_PADDING_START = 14

type GalleryFocus = { id: number; index: number; control: string }
type GalleryScrollAnchor = { id: number; index: number; withinRow: number }

function scrollAnchor(tasks: Task[], columns: number, offset: number): GalleryScrollAnchor | null {
  if (!tasks.length) return null
  const row = Math.max(0, Math.floor((offset - CARD_PADDING_START) / CARD_STEP))
  const index = Math.min(tasks.length - 1, row * columns)
  return { id: tasks[index].id, index, withinRow: offset - CARD_PADDING_START - row * CARD_STEP }
}

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

/** One continuous file library. Stable item keys keep focused cards alive across columns. */
export function TaskGallery({ tasks, selectedIds, onSelect, onFileCommand, onToggle, onRestart, actionBlocked = false, busyTaskIds, installProgress, empty }: TaskGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(0)
  const [focused, setFocused] = useState<GalleryFocus | null>(null)
  const pendingFocus = useRef<GalleryFocus | null>(null)
  const columns = Math.max(1, Math.floor((gridWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)))
  const cardWidth = Math.min(CARD_MAX_WIDTH, Math.max(0, (gridWidth - (columns - 1) * CARD_GAP) / columns))
  const indexById = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks])
  const focusedIndex = focused ? indexById.get(focused.id) ?? -1 : -1
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indices = defaultRangeExtractor(range)
    // Keep only the focused card in addition to the visible range, so wheel scrolling
    // cannot silently send keyboard focus to the document body.
    if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex)
    return indices.sort((a, b) => a - b)
  }, [focusedIndex])
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT,
    getItemKey: index => tasks[index].id,
    lanes: columns,
    gap: CARD_GAP,
    overscan: columns * 2,
    rangeExtractor,
    paddingStart: CARD_PADDING_START,
    paddingEnd: 16
  })
  const virtualItems = virtualizer.getVirtualItems()
  const previousLayout = useRef({ columns, tasks })
  const pendingColumnAnchor = useRef<{ columns: number; anchor: GalleryScrollAnchor | null } | null>(null)
  const previousSelection = useRef<number | null>(null)
  const singleSelectedId = selectedIds.size === 1 ? selectedIds.values().next().value ?? null : null

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = (): void => {
      const width = grid.clientWidth
      const nextColumns = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)))
      const previous = previousLayout.current
      // Capture before the shorter multi-column canvas can clamp scrollTop.
      pendingColumnAnchor.current = nextColumns !== previous.columns
        ? { columns: nextColumns, anchor: scrollAnchor(previous.tasks, previous.columns, scrollRef.current?.scrollTop ?? 0) }
        : null
      setGridWidth(width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const previous = previousLayout.current
    previousLayout.current = { columns, tasks }
    const columnsChanged = columns !== previous.columns
    const captured = pendingColumnAnchor.current
    // The measuring layout effect also runs before the initial width update
    // commits. Retain its snapshot until those new columns are actually rendered.
    if (columnsChanged) pendingColumnAnchor.current = null
    const scroll = scrollRef.current
    if (!scroll || !previous.tasks.length || !tasks.length) return
    const anchor = columnsChanged && captured?.columns === columns
      ? captured.anchor : scrollAnchor(previous.tasks, previous.columns, scroll.scrollTop)
    if (anchor && (columnsChanged || tasks[anchor.index]?.id !== anchor.id)) {
      // If the anchor was removed, retain the nearest surviving position.
      const nextIndex = indexById.get(anchor.id) ?? Math.min(anchor.index, tasks.length - 1)
      virtualizer.scrollToOffset(CARD_PADDING_START + Math.floor(nextIndex / columns) * CARD_STEP + anchor.withinRow)
    }
    if (focused && focusedIndex < 0) {
      const index = Math.min(focused.index, tasks.length - 1)
      const next = { id: tasks[index].id, index, control: 'select' }
      pendingFocus.current = next
      setFocused(next)
    }
  }, [columns, tasks, indexById, focused, focusedIndex, virtualizer])

  useLayoutEffect(() => {
    // A new single selection from the transfer island is an explicit reveal request.
    // Speed snapshots and reordering retain the same ID and never pull the user back.
    if (singleSelectedId === previousSelection.current) return
    previousSelection.current = singleSelectedId
    if (singleSelectedId != null) {
      const index = indexById.get(singleSelectedId)
      if (index != null) virtualizer.scrollToIndex(index, { align: 'auto' })
    }
  }, [singleSelectedId, indexById, virtualizer])

  useLayoutEffect(() => {
    const request = pendingFocus.current
    if (!request) return
    const target = gridRef.current?.querySelector<HTMLButtonElement>(`[data-gallery-card="${request.id}"] [data-gallery-focus="${request.control}"]`)
    if (target) {
      pendingFocus.current = null
      target.focus({ preventScroll: true })
    }
  })

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? CARD_STEP) / CARD_STEP))
    const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns
        : (event.key === 'PageUp' ? -1 : 1) * columns * pageRows
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tasks.length - 1
      : Math.min(tasks.length - 1, Math.max(0, index + offset))
    const next = { id: tasks[nextIndex].id, index: nextIndex, control: 'select' }
    pendingFocus.current = next
    setFocused(next)
    virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
  }

  return <section data-task-gallery className="task-gallery" aria-label="文件卡片"
    onFocusCapture={event => {
      const target = event.target as HTMLElement
      const card = target.closest<HTMLElement>('[data-gallery-card]')
      if (!card) return
      const id = Number(card.dataset.galleryCard)
      const index = indexById.get(id)
      if (index != null) setFocused({ id, index, control: target.dataset.galleryFocus ?? 'select' })
    }}
    onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
        pendingFocus.current = null
        setFocused(null)
      }
    }}>
    <div ref={scrollRef} className="task-gallery-scroll scroll-quiet" data-gallery-scroll hidden={!tasks.length}>
      <div ref={gridRef} className="task-gallery-grid" role="list" aria-label="文件卡片列表"
        data-gallery-columns={columns} style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map(item => {
          const task = tasks[item.index]
          return <GalleryCard key={task.id} task={task}
            style={{ width: cardWidth || CARD_MIN_WIDTH, height: CARD_HEIGHT, transform: `translate(${item.lane * (cardWidth + CARD_GAP)}px, ${item.start}px)` }}
            selected={selectedIds.has(task.id)} busy={busyTaskIds?.has(task.id) ?? false}
            actionBlocked={actionBlocked} installProgress={installProgress}
            position={item.index + 1} total={tasks.length}
            onSelect={onSelect} onFileCommand={onFileCommand} onToggle={onToggle} onRestart={onRestart}
            onNavigate={event => navigate(event, item.index)} />
        })}
      </div>
    </div>
    {!tasks.length ? empty ?? <div className="task-gallery-empty"><Files size={36} strokeWidth={1.2} aria-hidden /><p>这里还没有文件</p><span>添加下载后，在这里查看你的文件。</span></div> : null}
  </section>
}

const GalleryCard = memo(function GalleryCard({ task, style, selected, busy, actionBlocked, installProgress, position, total, onSelect, onFileCommand, onToggle, onRestart, onNavigate }: {
  task: Task
  style: CSSProperties
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

  const transferPreview = task.status === 'downloading' || task.status === 'waiting' || Boolean(task.awaitingDestination)
  const transferring = task.status === 'downloading' && !task.awaitingDestination && (!task.phase || task.phase === 'transferring')
  const duration = Math.max(0, Math.floor(task.recordedDuration ?? 0))
  const liveTime = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
  const metric = task.awaitingDestination ? '选择目录' : task.status === 'waiting' ? '等待开始'
    : recording ? liveTime : knownProgress ? String(Math.round(fraction * 100))
      : task.completedBytes > 0 ? formatBytes(task.completedBytes) : '等待数据'
  const metricLabel = recording ? `已保存 ${formatBytes(task.completedBytes)}`
    : transferring ? `${speed.value} ${speed.unit}`
      : task.status === 'paused' ? '已暂停' : task.status === 'error' ? '需要处理'
        : task.status === 'waiting' ? '轮到时自动开始' : task.awaitingDestination ? '选择后继续下载' : status

  return <article className="gallery-card" style={style} role="listitem" aria-posinset={position} aria-setsize={total}
    data-gallery-card={task.id} data-task-state={task.status} data-selected={selected}
    data-gallery-install-state={diskImage ? installError ? 'failed' : installing ? 'installing' : installedPath ? 'installed' : 'ready' : undefined}>
    <button type="button" className="gallery-card-select" data-gallery-select={task.id} data-task-select={task.id} data-gallery-focus="select"
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
    <div className="gallery-card-preview" data-gallery-preview-kind={transferPreview ? 'transfer' : visibleArtwork?.kind ?? 'file'}>
      {!transferPreview ? <>
        {!visibleArtwork || loadedSource !== visibleArtwork.source ? <div className="gallery-file-figure" aria-hidden><TypeMark category={task.category} size="lg" /></div> : null}
        {visibleArtwork ? <img className="gallery-card-artwork" src={visibleArtwork.source} alt="" aria-hidden draggable={false} loading="lazy" decoding="async"
          data-artwork-kind={visibleArtwork.kind} data-loaded={loadedSource === visibleArtwork.source}
          onLoad={() => setLoadedSource(visibleArtwork.source)} onError={() => setFailedSource(visibleArtwork.source)} /> : null}
        <span className="gallery-card-type" aria-hidden>{extension || CATEGORY_LABEL[task.category]}</span>
        {knownProgress ? <div className="gallery-card-progress" data-gallery-progress role="progressbar" aria-label={`${title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div> : null}
      </> : <div className="gallery-transfer" data-gallery-transfer data-live={recording || undefined}>
        <div className="gallery-transfer-heading"><span>{recording ? <span className="gallery-live-dot" /> : task.status === 'error' ? <CircleAlert size={12} /> : <ArrowDownToLine size={12} />}{status}</span><span>{extension || CATEGORY_LABEL[task.category]}</span></div>
        <div className="gallery-transfer-metric" data-gallery-metric>{metric}{knownProgress && !task.awaitingDestination && task.status !== 'waiting' ? <small>%</small> : null}</div>
        <div className="gallery-transfer-detail" data-gallery-speed>{metricLabel}</div>
        {knownProgress ? <div className="gallery-card-progress" data-gallery-progress role="progressbar" aria-label={`${title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div> : <div className="gallery-card-progress" data-gallery-progress="unknown" aria-hidden><span /></div>}
      </div>}
      <span className="gallery-card-selected" aria-hidden><Check size={12} strokeWidth={2.2} /></span>
      {installError ? <p id={`${id}-install-error`} className="gallery-card-install-error scroll-quiet" data-gallery-install-error data-gallery-focus="error" role="status" tabIndex={0}>{installError}</p> : null}
    </div>
    <div className="gallery-card-info">
      <p id={`${id}-title`} className="gallery-card-title" data-task-title title={task.filename || title}>{title}</p>
      <p id={`${id}-meta`} className="gallery-card-meta"><span>{CATEGORY_LABEL[task.category]}</span><span aria-hidden>·</span><span title={size}>{size}</span></p>
      <span id={`${id}-status`} className="gallery-card-status" title={[status, detail, task.diagnostic?.summary].filter(Boolean).join(' · ')}>
        {installError || task.status === 'error' ? <CircleAlert size={11} aria-hidden /> : diskImage && !installedPath ? <PackageOpen size={11} aria-hidden /> : complete ? <Check size={11} aria-hidden /> : null}
        <span>{status}</span>
        {!complete ? <small>{recording ? `已保存 ${formatBytes(task.completedBytes)}` : <>{knownProgress && !transferPreview ? `${progress} · ` : ''}{task.completedBytes > 0 ? `${formatBytes(task.completedBytes)}${task.fileSize > 0 ? ` / ${formatBytes(task.fileSize)}` : ' 已下载'}` : ''}</>}</small> : null}
      </span>
    </div>
    <div className="gallery-card-actions">
      <button type="button" className="gallery-card-primary" data-gallery-primary={installsApp ? 'install' : next.kind} data-gallery-focus="primary" aria-label={primaryAriaLabel}
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
      {complete ? <>
        <button type="button" data-gallery-preview data-gallery-focus="preview" aria-label={`快速预览：${title}`} onClick={() => onFileCommand(task, 'preview')}><Eye size={13} aria-hidden /><span>预览</span></button>
        <button type="button" data-gallery-reveal data-gallery-focus="reveal" aria-label={`在${FILE_MANAGER}中显示：${title}`} title={`在${FILE_MANAGER}中显示`} onClick={() => onFileCommand(task, 'reveal')}><FolderOpen size={14} aria-hidden /></button>
      </> : <button type="button" data-gallery-inspect data-gallery-focus="inspect" aria-label={`查看任务详情：${title}`} onClick={event => onSelect(task, event)}><SlidersHorizontal size={13} aria-hidden /><span>详情</span></button>}
    </div>
  </article>

})

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()
}
