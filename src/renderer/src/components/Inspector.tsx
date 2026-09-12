import { TaskTransferSummary } from './TaskTransferSummary'
import { CompletedFileCard } from './CompletedFileCard'
import { LiveSpeedChart } from './LiveSpeedChart'
import { CopyFeedback } from './ui/CopyFeedback'
import { CalendarDays, Captions, ChevronDown, ChevronRight, CircleAlert, Clock3, Cloud, ExternalLink, Eye, FileText, FolderOpen, ImageIcon, LoaderCircle, Minus, Music, PackageOpen, Square, Pause, Play, Plus, RefreshCcw, RotateCw, Share2, Trash2, VolumeX, X } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatByteProgress, formatBytes, formatEta, remainingSeconds, isDiskImageFile, taskDisplayTitle } from '../lib/format'
import {
  getCompletionStack,
  openExternal,
  openFile,
  quickLook,
  remove,
  renewTask,
  installDiskImage,
  revealFile,
  scheduleTask,
  finishTaskSchedule,
  setTaskBandwidth,
  setTaskConnections,
  shareFile
} from '../lib/store'
import { STATUS_LABEL, type CompletionArtifact, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { requiresPro } from '../lib/license'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { useCopyFeedback } from '../hooks/useCopyFeedback'
import { FILE_MANAGER, IS_WINDOWS, TRASH_NAME } from '../lib/platform'
import { ProChip } from './ProChip'
import type { InstallProgressState } from './TransferActivity'
import { appendSpeedTelemetry, subscribeTaskTelemetry } from '../lib/taskTelemetry'
import type { SpeedChartSample as SpeedSample } from '../lib/speedChartGeometry'

const INSPECTOR_WIDTH_KEY = 'ndm.inspector.width'
const INSPECTOR_WIDTH_MIN = 280
const INSPECTOR_WIDTH_DEFAULT = 360
const INSPECTOR_WIDTH_MAX = 420

/* One control metric for every button, chip and stepper in this pane.
   Text fields are one step taller; nothing else invents its own height. */
const CONTROL_CLASS = 'inline-flex h-control items-center justify-center gap-1.5 rounded-control border border-line px-2.5 text-label transition-[color,background-color,border-color,scale] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20 disabled:cursor-wait disabled:opacity-50'
const UTILITY_ITEM_CLASS = 'inspector-utility-action inline-flex h-control items-center gap-1.5 rounded-control px-2 text-body transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20 disabled:cursor-wait disabled:opacity-50'
const CHIP_CLASS = 'inline-flex h-control items-center rounded-control border px-2.5 text-label transition-[color,background-color,border-color,scale] duration-150 active:scale-[0.97] disabled:cursor-wait disabled:opacity-50'
const CHIP_SELECTED_CLASS = 'border-line-strong bg-raised font-medium text-paper'
const CHIP_RESTING_CLASS = 'border-line text-mist hover:text-paper hover:bg-paper/[0.045]'

/* Per-task speed presets. The unit lives in the field that owns the value,
   so the chips stay short and every label keeps a real name for AT. */
const BANDWIDTH_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: '跟随全局' },
  { value: 1_048_576, label: '1' },
  { value: 5_242_880, label: '5' },
  { value: 10_485_760, label: '10' }
]
const BANDWIDTH_MIN_MB = 0.01
const BANDWIDTH_MAX_MB = 1000

function clampInspectorWidth(width: number): number {
  return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, Math.round(width)))
}

function storedInspectorWidth(): number {
  if (typeof window === 'undefined') return INSPECTOR_WIDTH_DEFAULT
  const stored = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0
    ? clampInspectorWidth(stored)
    : INSPECTOR_WIDTH_DEFAULT
}

// Keep the pane mounted while task-local forms and callbacks reset per selection.
export function Inspector(props: Parameters<typeof TaskInspector>[0]) {
  const [inspectorWidth, setInspectorWidth] = useState(storedInspectorWidth)
  const paneRef = useRef<HTMLElement>(null)
  const [overlay, setOverlay] = useState(false)
  useLayoutEffect(() => {
    const parent = paneRef.current?.parentElement
    const sidebar = document.getElementById('main-sidebar')
    if (!parent) return
    const update = () => setOverlay(parent.clientWidth - inspectorWidth < 480)
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    if (sidebar) observer.observe(sidebar)
    update()
    return () => observer.disconnect()
  }, [inspectorWidth])
  const inspectorWidthRef = useRef(inspectorWidth)
  const stopInspectorResizeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth
  }, [inspectorWidth])

  useEffect(() => () => stopInspectorResizeRef.current?.(), [])
  const setAndStoreInspectorWidth = (width: number): void => {
    const nextWidth = clampInspectorWidth(width)
    inspectorWidthRef.current = nextWidth
    setInspectorWidth(nextWidth)
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(nextWidth))
  }

  const handleInspectorResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    stopInspectorResizeRef.current?.()
    const startX = event.clientX
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? inspectorWidthRef.current
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: PointerEvent): void => {
      const nextWidth = clampInspectorWidth(startWidth + startX - moveEvent.clientX)
      inspectorWidthRef.current = nextWidth
      setInspectorWidth(nextWidth)
    }
    const stopResize = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidthRef.current))
      stopInspectorResizeRef.current = null
    }

    stopInspectorResizeRef.current = stopResize
    window.addEventListener('blur', stopResize)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  const handleInspectorResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setAndStoreInspectorWidth(inspectorWidthRef.current + 16)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setAndStoreInspectorWidth(inspectorWidthRef.current - 16)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setAndStoreInspectorWidth(INSPECTOR_WIDTH_MIN)
    } else if (event.key === 'End') {
      event.preventDefault()
      setAndStoreInspectorWidth(INSPECTOR_WIDTH_MAX)
    }
  }

  return (
    <aside
      id="task-inspector"
      ref={paneRef}
      data-overlay={overlay || undefined}
      className="inspector-split relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: inspectorWidth, '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
    >
      <div
        role="separator"
        aria-label="调整任务详情宽度"
        aria-orientation="vertical"
        aria-controls="task-inspector"
        aria-valuemin={INSPECTOR_WIDTH_MIN}
        aria-valuemax={INSPECTOR_WIDTH_MAX}
        aria-valuenow={inspectorWidth}
        tabIndex={0}
        onPointerDown={handleInspectorResizeStart}
        title="拖动调整详情宽度 · 方向键微调 · 双击恢复"
        onDoubleClick={() => setAndStoreInspectorWidth(INSPECTOR_WIDTH_DEFAULT)}
        onKeyDown={handleInspectorResizeKey}
        className="group/resize absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize focus-visible:outline-none"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-paper/25 group-focus-visible/resize:bg-paper/35" />
      </div>
      <TaskInspector key={props.task.id} {...props} />
    </aside>
  )
}

function TaskInspector({
  task,
  installProgress,
  onClose,
  onUpgrade,
  taskActionBusy,
  taskActionErrorId,
  onTaskToggle,
  onTaskRestart,
  onTaskMutation
}: {
  task: Task
  installProgress?: InstallProgressState | null
  onClose: () => void
  onUpgrade: (reason: string) => void
  taskActionBusy: boolean
  taskActionErrorId?: string
  onTaskToggle: (task: Task) => void
  onTaskRestart: (task: Task) => void
  onTaskMutation: (task: Task, operation: () => Promise<void>, kind: 'schedule' | 'delete') => Promise<void>
}) {
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const pausable = downloading || task.status === 'waiting'
  const etaText = formatEta(downloading ? remainingSeconds(task) : null)
  const failed = task.status === 'error'
  const [copiedSource, copySource, copySourceError] = useCopyFeedback()
  const [copiedLink, copyLink, copyLinkError] = useCopyFeedback()
  const [copiedPath, copyPath, copyPathError] = useCopyFeedback()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingTask, setDeletingTask] = useState(false)
  const [deleteTaskError, setDeleteTaskError] = useState('')
  const [showRenew, setShowRenew] = useState(false)
  const [renewURL, setRenewURL] = useState(task.url)
  const [renewError, setRenewError] = useState<string | null>(null)
  const [renewing, setRenewing] = useState(false)
  const renewalPending = useRef(false)
  const [savingTaskConnections, setSavingTaskConnections] = useState(false)
  const [taskConnectionsError, setTaskConnectionsError] = useState('')
  const [savingTaskBandwidth, setSavingTaskBandwidth] = useState(false)
  const [taskBandwidthError, setTaskBandwidthError] = useState('')
  const [bandwidthDraft, setBandwidthDraft] = useState<number | null>(null)
  const [bandwidthInput, setBandwidthInput] = useState(() => limitInputValue(task.bandwidthLimit ?? 0))
  const [bandwidthInputInvalid, setBandwidthInputInvalid] = useState(false)
  const [savingTaskSchedule, setSavingTaskSchedule] = useState(false)
  const [taskScheduleError, setTaskScheduleError] = useState('')
  const [scheduleInputInvalid, setScheduleInputInvalid] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [scheduleOutside, setScheduleOutside] = useState(Boolean(task.startAt))
  const schedulePending = useRef(false)
  const scheduleTrigger = useRef<HTMLButtonElement>(null)
  const restoreScheduleFocus = useRef(false)
  const focusAfterSavedSchedule = useRef<number | null>(null)
  const [scheduleDate, setScheduleDate] = useState(() => formatScheduleDate(task.startAt))
  const [scheduleTime, setScheduleTime] = useState(() => formatScheduleTime(task.startAt))
  const [completionArtifacts, setCompletionArtifacts] = useState<CompletionArtifact[]>([])
  const [completionFilesExpanded, setCompletionFilesExpanded] = useState(false)
  const [installLaunchBusy, setInstallLaunchBusy] = useState(false)
  const [installLaunchError, setInstallLaunchError] = useState('')
  const [speedSamples, setSpeedSamples] = useState<SpeedSample[]>([])
  const speedSamplesRef = useRef<SpeedSample[]>([])
  const artwork = useTaskThumbnail(task)
  const sourceURL = task.pageURL && task.pageURL !== task.url ? task.pageURL : null
  const displayTitle = taskDisplayTitle(task)
  const sourceName = (() => { try { return new URL(sourceURL || task.url).hostname.replace(/^www\./, '') } catch { return task.source || '来源' } })()
  const customStartAt = parseScheduleInput(scheduleDate, scheduleTime)
  const summaryStatus = task.awaitingDestination ? '等待选择保存目录' : downloading && task.isLiveRecording ? task.phase === 'merging' ? '正在保存录制' : '正在录制直播' : STATUS_LABEL[task.status]
  const summaryAmount = completed
    ? formatBytes(task.fileSize || task.completedBytes)
    : !downloading && task.fileSize <= 0 ? (task.completedBytes > 0 ? `已下载 ${formatBytes(task.completedBytes)} · 大小未知` : '大小未知') : formatByteProgress(task.completedBytes, task.fileSize)
  // What the limit control shows: the optimistic choice until the engine answers.
  const activeLimit = bandwidthDraft ?? task.bandwidthLimit ?? 0
  const globalLimit = task.effectiveBandwidthLimit ?? 0


  useEffect(() => {
    setScheduleDate(formatScheduleDate(task.startAt))
    setScheduleTime(formatScheduleTime(task.startAt))
    setScheduleInputInvalid(false)
    setEditingSchedule(false)
    if (task.startAt) setScheduleOutside(true)
  }, [task.id, task.startAt])

  useEffect(() => {
    if (!savingTaskSchedule && !taskActionBusy && restoreScheduleFocus.current
      && (!task.startAt || scheduleOutside)
      && (focusAfterSavedSchedule.current === null || task.startAt === focusAfterSavedSchedule.current)) {
      restoreScheduleFocus.current = false
      focusAfterSavedSchedule.current = null
      scheduleTrigger.current?.focus()
    }
  }, [savingTaskSchedule, task.startAt, scheduleOutside, taskActionBusy])

  useEffect(() => {
    setTaskConnectionsError('')
    setTaskBandwidthError('')
  }, [task.id])

  // The engine owns the durable limit. A fresh value (unrelated change, or our
  // own acknowledged save) retires the optimistic draft and its input text.
  useEffect(() => {
    setBandwidthDraft(null)
    setBandwidthInput(limitInputValue(task.bandwidthLimit ?? 0))
    setBandwidthInputInvalid(false)
    setTaskBandwidthError('')
  }, [task.id, task.bandwidthLimit])

  useLayoutEffect(() => {
    speedSamplesRef.current = []
    setSpeedSamples([])
    if (!downloading) return
    // Subscribe to real arrivals rather than object/value changes: unchanged
    // snapshots preserve list identities, but are still new measurements.
    return subscribeTaskTelemetry(task.id, sample => {
      const next = appendSpeedTelemetry(speedSamplesRef.current, sample)
      if (next === speedSamplesRef.current) return
      speedSamplesRef.current = next
      setSpeedSamples(next)
    })
  }, [downloading, task.id])

  useEffect(() => {
    let cancelled = false
    setCompletionFilesExpanded(false)
    if (!completed) {
      setCompletionArtifacts([])
      return () => { cancelled = true }
    }
    setCompletionArtifacts([])
    void getCompletionStack(task.id)
      .then((artifacts) => {
        if (!cancelled) setCompletionArtifacts(artifacts)
      })
      .catch(() => {
        if (!cancelled) setCompletionArtifacts([])
      })
    return () => { cancelled = true }
  }, [completed, task.id, task.filename, task.folderPath])

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename
  const matchingInstall = installProgress?.path === filePath ? installProgress : null
  const installedPath = artwork?.installedPath ?? matchingInstall?.installedPath
  const actionPath = filePath
  const installsApp = completed && !IS_WINDOWS && isDiskImageFile(filePath) && !installedPath
  const installInProgress = Boolean(matchingInstall && !['complete', 'failed', 'cancelled'].includes(matchingInstall.phase))
  const installing = installLaunchBusy || installInProgress
  const installError = installLaunchError || (matchingInstall?.phase === 'failed' ? matchingInstall.detail || '安装流程未完成' : '')

  useEffect(() => {
    setInstallLaunchBusy(false)
    setInstallLaunchError('')
  }, [task.id, installedPath])

  const handleCopyLink = (): void => {
    void copyLink(task.url)
  }

  const handleCopySource = (): void => {
    if (sourceURL) copySource(sourceURL)
  }

  const handleCopyPath = (): void => {
    void copyPath(actionPath)
  }

  const handleReveal = (): void => {
    void revealFile(completed ? actionPath : task.folderPath || actionPath)
  }

  const handleOpen = async (): Promise<string | void> => {
    if (!installsApp) return openFile(installedPath || actionPath)
    if (installing) return
    setInstallLaunchBusy(true)
    setInstallLaunchError('')
    await installDiskImage(filePath)
      .then((result) => {
        if (result) setInstallLaunchError(result)
      })
      .catch(() => setInstallLaunchError('未能开始安装，请重试。'))
      .finally(() => setInstallLaunchBusy(false))
  }

  const handleRestart = (): void => {
    onTaskRestart(task)
  }

  const handleRenew = (): void => {
    if (renewalPending.current) return
    const url = renewURL.trim()
    if (!/^https?:\/\//i.test(url)) {
      setRenewError('请输入完整的 HTTP 或 HTTPS 下载链接')
      return
    }
    setRenewError(null)
    renewalPending.current = true
    setRenewing(true)
    void renewTask(task.id, url)
      .then(() => {
        if (!mounted.current) return
        cue('success')
        setShowRenew(false)
      })
      .catch((error: unknown) => {
        if (mounted.current) setRenewError(error instanceof Error ? error.message : '更新链接失败')
      })
      .finally(() => {
        renewalPending.current = false
        if (mounted.current) setRenewing(false)
      })
  }

  const handleTaskBandwidth = async (bandwidthLimit: number): Promise<void> => {
    if (savingTaskBandwidth || bandwidthLimit === (task.bandwidthLimit ?? 0)) return
    // The chosen tier is painted immediately; the engine acknowledgement still
    // owns the durable value and rolls the control back when it refuses.
    setBandwidthDraft(bandwidthLimit)
    setBandwidthInput(limitInputValue(bandwidthLimit))
    setBandwidthInputInvalid(false)
    setTaskBandwidthError('')
    setSavingTaskBandwidth(true)
    try {
      await setTaskBandwidth(task.id, bandwidthLimit)
    } catch {
      if (!mounted.current) return
      setBandwidthDraft(null)
      setBandwidthInput(limitInputValue(task.bandwidthLimit ?? 0))
      setTaskBandwidthError('未能保存此任务的限速。请重试。')
    } finally {
      if (mounted.current) setSavingTaskBandwidth(false)
    }
  }

  const applyBandwidthInput = (): void => {
    // Leaving the field alone is not an edit: a click in and out must not
    // rewrite the limit with the rounded text the field displays.
    if (bandwidthInput.trim() === limitInputValue(task.bandwidthLimit ?? 0)) return
    const parsed = parseLimitInput(bandwidthInput)
    if (!parsed.ok) {
      setBandwidthInputInvalid(true)
      setTaskBandwidthError(`限速需在 ${BANDWIDTH_MIN_MB} 到 ${BANDWIDTH_MAX_MB} MB/s 之间。`)
      return
    }
    void handleTaskBandwidth(parsed.bytes)
  }

  const handleTaskConnections = async (connections: number): Promise<void> => {
    if (savingTaskConnections) return
    setSavingTaskConnections(true)
    setTaskConnectionsError('')
    try {
      await setTaskConnections(task.id, connections)
      cue('toggle')
    } catch {
      setTaskConnectionsError('未能保存此任务的连接数。请重试。')
    } finally {
      setSavingTaskConnections(false)
    }
  }

  const handleTaskSchedule = async (startAt: number | null): Promise<void> => {
    if (schedulePending.current) return
    schedulePending.current = true
    restoreScheduleFocus.current = false
    focusAfterSavedSchedule.current = null
    setSavingTaskSchedule(true)
    setTaskScheduleError('')
    setScheduleInputInvalid(false)
    try {
      await onTaskMutation(task, async () => { await scheduleTask(task.id, startAt) }, 'schedule')
      if (mounted.current) {
        focusAfterSavedSchedule.current = startAt
        restoreScheduleFocus.current = true
        setEditingSchedule(false)
        cue('toggle')
      }
    } catch {
      if (mounted.current) setTaskScheduleError('未能保存此任务的预约。请重试。')
    } finally {
      schedulePending.current = false
      if (mounted.current) setSavingTaskSchedule(false)
    }
  }

  const handleCustomSchedule = (): void => {
    if (customStartAt == null || customStartAt <= Date.now()) {
      setTaskScheduleError('请输入有效的未来日期和时间。')
      setScheduleInputInvalid(true)
      return
    }
    void handleTaskSchedule(customStartAt)
  }

  const handleFinishSchedule = async (action: 'start' | 'cancel'): Promise<void> => {
    if (schedulePending.current) return
    schedulePending.current = true
    restoreScheduleFocus.current = false
    focusAfterSavedSchedule.current = null
    setSavingTaskSchedule(true)
    setTaskScheduleError('')
    try {
      await onTaskMutation(task, async () => { await finishTaskSchedule(task.id, action) }, 'schedule')
      if (mounted.current) { setEditingSchedule(false); cue('toggle') }
    } catch (error) {
      if (mounted.current) setTaskScheduleError(error instanceof Error ? error.message : '未能更改预约，请重试。')
    } finally {
      schedulePending.current = false
      if (mounted.current) { restoreScheduleFocus.current = true; setSavingTaskSchedule(false) }
    }
  }

  const handleDelete = async (deleteFile: boolean): Promise<void> => {
    if (deletingTask) return
    setDeletingTask(true)
    setDeleteTaskError('')
    try {
      await onTaskMutation(task, async () => { await remove(task.id, deleteFile) }, 'delete')
      if (!mounted.current) return
      cue('success')
      setShowDeleteConfirm(false)
      onClose()
    } catch {
      if (!mounted.current) return
      setDeleteTaskError(deleteFile
        ? `未能删除任务或将文件移到${TRASH_NAME}。请重试。`
        : '未能从列表移除任务。请重试。')
    } finally {
      if (mounted.current) setDeletingTask(false)
    }
  }

  const requestDelete = (): void => {
    if (taskActionBusy || schedulePending.current) return
    setDeleteTaskError('')
    setShowDeleteConfirm(true)
  }

  // Keep an open editor in place while awaiting the engine. A confirmed
  // appointment moves into the summary and stays there for cancel/start feedback.
  const showScheduleOutside = scheduleOutside
  const scheduleControls = (
    <div
      role="group"
      aria-label="定时开始"
      aria-busy={savingTaskSchedule}
      aria-describedby={taskScheduleError ? 'task-schedule-status' : undefined}
      data-task-start-at={task.startAt ?? ''}
      className={showScheduleOutside ? 'mt-4 border-t border-line/60 pt-3' : undefined}
    >
      {task.startAt ? (
        <>
          <div className="flex items-center gap-2 text-label text-fog">
            <Clock3 size={13} aria-hidden className="shrink-0" />
            <span>将于 <time dateTime={new Date(task.startAt).toISOString()}>{new Date(task.startAt).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time> 开始</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={`${CONTROL_CLASS} text-paper hover:bg-raised`} disabled={savingTaskSchedule || taskActionBusy} onClick={() => void handleFinishSchedule('start')}>
              <Play size={12} aria-hidden />立即开始
            </button>
            <button ref={scheduleTrigger} type="button" className={`${CONTROL_CLASS} text-mist hover:text-paper`} aria-expanded={editingSchedule} aria-controls="task-schedule-editor" disabled={savingTaskSchedule || taskActionBusy} onClick={() => setEditingSchedule(!editingSchedule)}>修改</button>
            <button type="button" className={`${CONTROL_CLASS} text-mist hover:text-paper`} disabled={savingTaskSchedule || taskActionBusy} onClick={() => void handleFinishSchedule('cancel')}>取消预约</button>
          </div>
        </>
      ) : (
        <button ref={scheduleTrigger} type="button" className={`${CONTROL_CLASS} text-fog hover:bg-raised`} aria-expanded={editingSchedule} aria-controls="task-schedule-editor" disabled={savingTaskSchedule || taskActionBusy || task.awaitingDestination} onClick={() => setEditingSchedule(!editingSchedule)}>
          <Clock3 size={13} aria-hidden />稍后开始
        </button>
      )}
      <p id="task-schedule-status" role="status" aria-live="polite" className={taskScheduleError ? 'mt-1.5 text-meta text-clay' : savingTaskSchedule ? 'mt-1.5 text-meta text-mist' : 'sr-only'}>
        {taskScheduleError || (savingTaskSchedule ? '正在更新预约…' : '')}
      </p>
      {editingSchedule ? (
        <div id="task-schedule-editor" data-schedule-editor>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_88px] gap-1.5">
                <label className="flex h-field min-w-0 items-center gap-1.5 rounded-control border border-line bg-panel/55 px-2 focus-within:border-copper/60">
                  <CalendarDays size={13} className="shrink-0 text-mist" />
                  <input
                    autoFocus
                    value={scheduleDate}
                    onChange={(event) => {
                      setScheduleDate(normalizeScheduleDate(event.target.value))
                      if (taskScheduleError) setTaskScheduleError('')
                      if (scheduleInputInvalid) setScheduleInputInvalid(false)
                    }}
                    inputMode="numeric"
                    placeholder="日/月/年"
                    aria-label="预约日期，日月年"
                    aria-invalid={scheduleInputInvalid}
                    aria-describedby={taskScheduleError ? 'task-schedule-status' : undefined}
                    disabled={savingTaskSchedule || taskActionBusy}
                    className="min-w-0 flex-1 bg-transparent font-mono text-label tabular-nums text-paper outline-none placeholder:text-mist/60 disabled:cursor-wait disabled:opacity-55"
                  />
                </label>
                <label className="flex h-field items-center gap-1.5 rounded-control border border-line bg-panel/55 px-2 focus-within:border-copper/60">
                  <Clock3 size={13} className="shrink-0 text-mist" />
                  <input
                    value={scheduleTime}
                    onChange={(event) => {
                      setScheduleTime(normalizeScheduleTime(event.target.value))
                      if (taskScheduleError) setTaskScheduleError('')
                      if (scheduleInputInvalid) setScheduleInputInvalid(false)
                    }}
                    inputMode="numeric"
                    placeholder="时:分"
                    aria-label="预约时间，时和分"
                    aria-invalid={scheduleInputInvalid}
                    aria-describedby={taskScheduleError ? 'task-schedule-status' : undefined}
                    disabled={savingTaskSchedule || taskActionBusy}
                    className="w-full min-w-0 bg-transparent font-mono text-label tabular-nums text-paper outline-none placeholder:text-mist/60 disabled:cursor-wait disabled:opacity-55"
                  />
                </label>
                <button
                  type="button"
                  disabled={savingTaskSchedule || taskActionBusy}
                  onClick={handleCustomSchedule}
                  className="col-span-2 h-field rounded-control border border-line px-2.5 text-label text-copper transition-[background-color,color,scale] duration-100 hover:bg-copper/10 active:scale-[0.96] disabled:cursor-default disabled:text-mist/45 disabled:hover:bg-transparent"
                >
                  {task.startAt ? '保存修改' : '预约'}
                </button>
              </div>
              <p className="mt-1.5 text-meta text-mist">日期按日／月／年填写，时间使用 24 小时制</p>
          <button type="button" className="mt-1.5 text-label text-mist hover:text-paper" disabled={savingTaskSchedule || taskActionBusy} onClick={() => {
            setScheduleDate(formatScheduleDate(task.startAt))
            setScheduleTime(formatScheduleTime(task.startAt))
            setScheduleInputInvalid(false)
            setTaskScheduleError('')
            setEditingSchedule(false)
            scheduleTrigger.current?.focus()
          }}>取消编辑</button>
        </div>
      ) : null}
    </div>
  )

  return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="inspector-heading app-drag flex shrink-0 items-center justify-between">
        <div className="text-label font-medium text-fog">任务详情</div>
        <button
          type="button"
          data-cuelume-press="tick"
          onClick={onClose}
          aria-label="关闭任务详情"
          title="关闭任务详情"
          className="app-no-drag grid size-control place-items-center rounded-control text-mist transition-colors hover:bg-line hover:text-paper"
        >
          <X size={14} />
        </button>
      </div>

      <div className="inspector-content flex-1 overflow-y-auto px-5 pb-6 scroll-quiet">
        <h2 className="line-clamp-3 break-words font-sans text-title font-medium tracking-[-0.02em]" title={displayTitle}>
          {displayTitle}
        </h2>
        <p className="mt-1.5 truncate text-label text-mist">{sourceName}</p>


        {completed ? (
          <div data-inspector-summary className="mt-5 flex items-center gap-2 text-label text-mist" aria-label="任务概要">
            <span className="text-fog">{summaryStatus}</span><span aria-hidden>·</span><span>{summaryAmount}</span>
          </div>
        ) : <TaskTransferSummary task={task} status={summaryStatus} amount={summaryAmount} eta={etaText} />}
        {downloading && !task.isLiveRecording ? <LiveSpeedChart samples={speedSamples} current={task.bytesPerSecond} /> : null}

        {failed && task.errorText ? (
          <section data-download-failure className="mt-5 border-t border-line/60 pt-3.5">
            <div className="flex items-start gap-2.5">
              <CircleAlert size={14} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-clay" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-paper">{task.diagnostic?.title || '下载未完成'}</p>
                <p className="mt-1 text-label leading-relaxed text-fog">
                  {task.diagnostic?.primaryAction === 'renew' && !task.pageURL
                    ? '请更新下载链接后重试。'
                    : task.diagnostic?.message || '请重试。若仍失败，请检查网络和保存位置。'}
                </p>
                {!task.diagnostic ? (
                  <details className="mt-2 text-meta text-mist">
                    <summary className="cursor-pointer hover:text-fog">错误详情</summary>
                    <p className="mt-1 break-words whitespace-pre-wrap">{task.errorText}</p>
                  </details>
                ) : null}
              </div>
            </div>
            {showRenew ? (
              <div className="mt-3 space-y-2 ps-[24px]">
                <input
                  autoFocus
                  value={renewURL}
                  disabled={renewing}
                  onChange={(event) => {
                    setRenewURL(event.target.value)
                    setRenewError(null)
                  }}
                  className="h-field w-full rounded-control border border-line bg-ink/40 px-2.5 font-mono text-label text-paper outline-none transition-colors focus:border-copper/60 disabled:cursor-wait disabled:opacity-55"
                  aria-label="新的下载链接"
                  spellCheck={false}
                />
                {renewError ? <p className="text-meta text-clay">{renewError}</p> : null}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={renewing}
                    aria-busy={renewing}
                    onClick={handleRenew}
                    className="inline-flex h-field items-center rounded-control bg-copper px-3 text-label font-medium text-on-accent transition-[background-color,scale] duration-150 active:scale-[0.97] hover:bg-copper-deep disabled:cursor-wait disabled:opacity-55"
                  >
                    更新并继续
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRenew(false)}
                    className="inline-flex h-field items-center rounded-control px-2.5 text-label text-mist transition-colors duration-150 hover:bg-paper/[0.045] hover:text-paper"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

      {completed && installError ? (
        <p data-inspector-install-error className="mt-4 flex items-start gap-2.5 text-label leading-relaxed text-fog">
          <CircleAlert size={14} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-clay" />
          <span className="min-w-0 break-words">{installError}</span>
        </p>
      ) : null}

      {completed ? (
        <>
          <CompletedFileCard
            fileKey={actionPath}
            filename={task.filename}
            artwork={artwork}
            fileManager={FILE_MANAGER}
            openIcon={installedPath ? ExternalLink : installing ? LoaderCircle : installError ? RotateCw : installsApp ? PackageOpen : ExternalLink}
            openLabel={installedPath ? '打开应用' : installing ? '安装中' : installError ? '重新安装' : installsApp ? '安装应用' : '打开文件'}
            openBusy={installing}
            onOpen={handleOpen}
            onPreview={() => quickLook(actionPath)}
            onReveal={() => revealFile(actionPath)}
            onShare={!IS_WINDOWS ? () => shareFile(actionPath) : undefined}
            onFileDrag={(event) => {
              event.preventDefault()
              event.stopPropagation()
              window.ndm?.startFileDrag?.([actionPath])
            }}
          />
          <div data-inspector-file-actions className="inspector-file-actions" aria-label="任务操作">
            <Action variant="utility" icon={Trash2} label="删除" tone="danger" disabled={taskActionBusy} onClick={requestDelete} />
          </div>
        </>
      ) : (
        <div data-inspector-actions className="mt-3 flex flex-wrap items-center gap-2">
          {failed ? (
            ['openPage', 'renew'].includes(task.diagnostic?.primaryAction || '') && task.pageURL ? (
              <Action icon={ExternalLink} label="打开来源页面" onClick={() => void openExternal(task.pageURL!)} />
            ) : task.diagnostic?.primaryAction === 'renew' ? (
              <Action icon={RotateCw} label="更新下载链接…" onClick={() => setShowRenew(true)} />
            ) : (
              <Action icon={RotateCw} label="重试" disabled={taskActionBusy} describedBy={taskActionErrorId} onClick={handleRestart} />
            )
          ) : (
            <Action
              icon={downloading && task.isLiveRecording ? Square : pausable ? Pause : Play}
              label={task.awaitingDestination ? '选目录' : downloading && task.isLiveRecording ? '停止并保存' : pausable ? '暂停' : '继续'}
              disabled={taskActionBusy}
              describedBy={taskActionErrorId}
              onClick={() => onTaskToggle(task)}
            />
          )}
          <Action variant="utility" icon={Trash2} label="删除" tone="danger" disabled={taskActionBusy} onClick={requestDelete} />
        </div>
      )}

      {!completed && showScheduleOutside ? scheduleControls : null}

      {!completed && artwork ? (
        <figure className="media-thumbnail mt-4 overflow-hidden rounded-surface bg-ink/35">
          <div className="aspect-video">
            <img src={artwork.source} alt={`${task.title || task.filename} 的预览图`} draggable={false}
              className={`h-full w-full object-contain ${artwork.kind === 'icon' ? 'p-5' : ''}`} />
          </div>
        </figure>
      ) : null}

        <section className="inspector-file-info" aria-label="文件信息">
          <DetailValue
            label="保存位置"
            value={actionPath}
            displayValue={(task.folderPath || actionPath).split(/[\\/]/).filter(Boolean).join(' › ')}
            copied={copiedPath}
            copyError={copyPathError}
            onCopy={handleCopyPath}
            onOpen={handleReveal}
            openLabel={`在${FILE_MANAGER}中显示保存位置`}
            openIcon={FolderOpen}
            expandable={false}
          />
          {sourceURL ? (
            <DetailValue
              label="来源网页"
              value={sourceURL}
              displayValue={readableURL(sourceURL)}
              copied={copiedSource}
              copyError={copySourceError}
              onCopy={handleCopySource}
              onOpen={() => void openExternal(sourceURL)}
              openLabel="在浏览器中打开来源网页"
            />
          ) : null}
          <DetailValue
            label="下载链接"
            value={task.url}
            displayValue={readableURL(task.url)}
            copied={copiedLink}
            copyError={copyLinkError}
            onCopy={handleCopyLink}
            onOpen={() => void openExternal(task.url)}
            openLabel="在浏览器中打开下载链接"
          />
          {displayTitle !== task.filename ? (
            <div className="inspector-detail-field">
              <div className="inspector-detail-label">文件名</div>
              <p className="mt-1 select-text break-words [overflow-wrap:anywhere] text-body text-fog">{task.filename}</p>
            </div>
          ) : null}
        </section>

        {task.deliveryNote ? (
          <section className="mt-5 border-t border-line/60 pt-3.5">
            <div className="flex items-start gap-2.5">
              <VolumeX size={14} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-copper" />
              <div className="min-w-0">
                <p className="text-body font-medium text-paper">{task.deliveryNote.title}</p>
                <p className="mt-1 text-label leading-relaxed text-fog">{task.deliveryNote.detail}</p>
              </div>
            </div>
          </section>
        ) : null}
        {completed && completionArtifacts.length > 1 ? (
          <CompletionFiles
            artifacts={completionArtifacts}
            expanded={completionFilesExpanded}
            onToggle={() => setCompletionFilesExpanded((value) => !value)}
          />
        ) : null}

        {COMMERCIALIZATION_DRAFT_ENABLED ? (
          <div className="mt-5 space-y-2 border-t border-line/60 pt-3.5">
            <p className="text-meta font-medium uppercase tracking-[0.16em] text-mist">后期与同步</p>
            <ProRow
              icon={RefreshCcw}
              title="转换成其他格式"
              note="下载完成后直接转成 MP4 / MOV / GIF"
              locked={requiresPro('convert')}
              onClick={() => onUpgrade('格式转换与音频提取')}
            />
            <ProRow
              icon={Music}
              title="提取音轨"
              note="从视频中抽出 M4A，原文件保留"
              locked={requiresPro('convert')}
              onClick={() => onUpgrade('格式转换与音频提取')}
            />
            <ProRow
              icon={Cloud}
              title="历史云同步"
              note="这条记录在你的其他 Mac 上也能看到"
              locked={requiresPro('cloudHistory')}
              onClick={() => onUpgrade('下载历史云同步')}
            />
          </div>
        ) : null}

        {!completed ? (
          <details className="mt-5 space-y-3 border-t border-line/60 pt-3.5">
            <summary className="cursor-pointer text-label font-medium text-fog hover:text-paper">下载设置</summary>
            <div
              role="group"
              aria-label="任务连接数"
              aria-busy={savingTaskConnections}
              aria-describedby={taskConnectionsError ? 'task-connections-status' : undefined}
              data-task-connections={task.connections}
              className="flex items-center justify-between gap-3"
            >
              <div>
                <div className="text-body font-medium text-paper">连接上限</div>
                <p className="mt-0.5 text-meta text-mist">
                  {task.status === 'downloading' && task.activeRequests != null
                    ? `当前活跃 ${task.activeRequests} 路${task.requestLimit != null && task.requestLimit < task.connections ? ` · 暂限 ${task.requestLimit} 路` : ''}`
                    : '下载时同时使用的最大连接数'}
                </p>
                <p
                  id="task-connections-status"
                  role="status"
                  aria-live="polite"
                  className={taskConnectionsError ? 'mt-1 text-meta text-clay' : 'sr-only'}
                >
                  {taskConnectionsError}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={savingTaskConnections || task.connections <= 1}
                  className="grid size-control place-items-center rounded-control border border-line text-mist transition-colors hover:border-line-strong hover:text-paper disabled:cursor-wait disabled:opacity-45"
                  onClick={() => void handleTaskConnections(Math.max(1, task.connections - 1))}
                  aria-label="减少连接"
                >
                  <Minus size={12} />
                </button>
                <span className="w-6 text-center font-mono text-label tabular-nums">{task.connections}</span>
                <button
                  type="button"
                  disabled={savingTaskConnections || task.connections >= 32}
                  className="grid size-control place-items-center rounded-control border border-line text-mist transition-colors hover:border-line-strong hover:text-paper disabled:cursor-wait disabled:opacity-45"
                  onClick={() => void handleTaskConnections(Math.min(32, task.connections + 1))}
                  aria-label="增加连接"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div
              role="group"
              aria-label="此任务限速"
              aria-busy={savingTaskBandwidth}
              aria-describedby={taskBandwidthError ? 'task-bandwidth-status' : undefined}
              data-task-bandwidth={task.bandwidthLimit ?? 0}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body font-medium text-paper">此任务限速</div>
                  <p className="mt-0.5 text-meta text-mist">
                    {activeLimit > 0
                      ? `当前限制为 ${limitLabel(activeLimit)} MB/s`
                      : globalLimit > 0
                        ? `当前跟随全局 ${limitLabel(globalLimit)} MB/s`
                        : '当前跟随全局，不限速'}
                  </p>
                </div>
                <label
                  className={`flex h-field w-[118px] shrink-0 items-center gap-1.5 rounded-control border bg-panel/55 px-2.5 transition-colors duration-150 focus-within:border-copper/60 ${
                    bandwidthInputInvalid ? 'border-clay/60' : 'border-line'
                  }`}
                >
                  <input
                    value={bandwidthInput}
                    onChange={(event) => {
                      setBandwidthInput(event.target.value.replace(/[^0-9.]/g, ''))
                      if (taskBandwidthError) setTaskBandwidthError('')
                      if (bandwidthInputInvalid) setBandwidthInputInvalid(false)
                    }}
                    onBlur={(event) => {
                      // A preset chip is an explicit choice; do not race it with a
                      // save triggered by this field losing focus.
                      if (event.relatedTarget instanceof HTMLButtonElement) return
                      applyBandwidthInput()
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      applyBandwidthInput()
                    }}
                    inputMode="decimal"
                    placeholder="跟随全局"
                    aria-label="自定义任务限速，每秒 MB"
                    aria-invalid={bandwidthInputInvalid}
                    aria-describedby={taskBandwidthError ? 'task-bandwidth-status' : undefined}
                    aria-busy={savingTaskBandwidth}
                    spellCheck={false}
                    className="min-w-0 flex-1 bg-transparent font-mono text-label tabular-nums text-paper outline-none placeholder:font-sans placeholder:text-meta placeholder:text-mist/60"
                  />
                  <span aria-hidden className="shrink-0 text-meta text-mist">MB/s</span>
                </label>
              </div>
              <p
                id="task-bandwidth-status"
                role="status"
                aria-live="polite"
                className={taskBandwidthError ? 'mt-1.5 text-meta text-clay' : 'sr-only'}
              >
                {taskBandwidthError}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {BANDWIDTH_PRESETS.map((preset) => {
                  const selected = activeLimit === preset.value
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={selected}
                      aria-label={preset.value === 0 ? preset.label : `${preset.label} MB/s`}
                      data-cuelume-press="tick"
                      onClick={() => void handleTaskBandwidth(preset.value)}
                      className={`${CHIP_CLASS} ${selected ? CHIP_SELECTED_CLASS : CHIP_RESTING_CLASS}`}
                    >
                      {preset.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {!showScheduleOutside ? scheduleControls : null}
          </details>
        ) : null}

      </div>

      {/* Delete confirmation dialog overlay */}
      {showDeleteConfirm ? (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-ink/70 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            aria-busy={deletingTask}
            className="rounded-surface border border-line-strong bg-raised p-4 shadow-dialog"
          >
            <h4 id="delete-task-title" className="text-body font-medium text-paper">确定删除下载？</h4>
            <p className="mt-1 text-label leading-relaxed text-mist">您可以选择仅从列表中移除任务，或将已下载文件移到{TRASH_NAME}。</p>
            <p
              id="task-delete-status"
              role="status"
              aria-live="polite"
              className={deleteTaskError ? 'mt-2 text-meta text-clay' : 'sr-only'}
            >
              {deleteTaskError}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={deletingTask}
                onClick={() => void handleDelete(false)}
                className="h-field w-full rounded-control border border-line text-label text-fog transition-colors hover:bg-line hover:text-paper disabled:cursor-wait disabled:opacity-55"
              >
                仅从列表移除
              </button>
              <button
                type="button"
                disabled={deletingTask}
                onClick={() => void handleDelete(true)}
                className="h-field w-full rounded-control bg-clay/15 text-label font-medium text-clay transition-colors hover:bg-clay/25 disabled:cursor-wait disabled:opacity-55"
              >
                同时移到{TRASH_NAME}
              </button>
              <button
                type="button"
                disabled={deletingTask}
                onClick={() => {
                  setDeleteTaskError('')
                  setShowDeleteConfirm(false)
                }}
                className="h-control w-full rounded-control text-label text-mist transition-colors hover:bg-paper/[0.045] hover:text-paper disabled:cursor-wait disabled:opacity-55"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}


      </div>
  )
}

function CompletionFiles({
  artifacts,
  expanded,
  onToggle
}: {
  artifacts: CompletionArtifact[]
  expanded: boolean
  onToggle: () => void
}) {
  const subtitleCount = artifacts.filter((artifact) => artifact.kind === 'subtitle').length
  const summary = [`${artifacts.length} 个文件`, subtitleCount > 0 ? `${subtitleCount} 份字幕` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="mt-5 border-t border-line/60 pt-3.5" aria-label="完成文件">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 rounded-control py-1 text-left"
      >
        <span className="flex items-center gap-2 text-label font-medium text-paper">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          完成文件
        </span>
        <span className="text-meta text-mist">{summary}</span>
      </button>
      {expanded ? (
        <div
          className="mt-2 overflow-hidden rounded-surface border border-line/70"
          role="list"
          aria-label="完成文件列表"
        >
          {artifacts.map((artifact) => (
            <div
              key={artifact.path}
              role="listitem"
              className="flex min-h-11 items-center gap-2.5 border-b border-line/55 px-2.5 py-2 last:border-b-0"
            >
              <CompletionArtifactIcon kind={artifact.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label text-paper" title={artifact.name}>{artifact.name}</span>
                <span className="mt-0.5 block text-meta text-mist">
                  {completionArtifactLabel(artifact.kind)}{artifact.byteCount > 0 ? ` · ${formatBytes(artifact.byteCount)}` : ''}
                </span>
              </span>
              <button
                type="button"
                aria-label={`打开 ${artifact.name}`}
                title="打开"
                onClick={() => void openFile(artifact.path)}
                className="grid size-control shrink-0 place-items-center rounded-control text-mist hover:bg-raised hover:text-paper"
              >
                <ExternalLink size={13} />
              </button>
              <button
                type="button"
                aria-label={`在${FILE_MANAGER}中显示 ${artifact.name}`}
                title={`在${FILE_MANAGER}中显示`}
                onClick={() => void revealFile(artifact.path)}
                className="grid size-control shrink-0 place-items-center rounded-control text-mist hover:bg-raised hover:text-paper"
              >
                <FolderOpen size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CompletionArtifactIcon({ kind }: { kind: CompletionArtifact['kind'] }) {
  const className = 'shrink-0 text-copper'
  switch (kind) {
    case 'subtitle': return <Captions size={15} className={className} />
    case 'cover': return <ImageIcon size={15} className={className} />
    case 'audio': return <Music size={15} className={className} />
    case 'metadata': return <FileText size={15} className={className} />
    default: return <Play size={15} className={className} />
  }
}

function completionArtifactLabel(kind: CompletionArtifact['kind']): string {
  switch (kind) {
    case 'primary': return '主文件'
    case 'subtitle': return '字幕'
    case 'cover': return '封面'
    case 'audio': return '音频'
    case 'metadata': return '资料'
    case 'other': return '其他'
  }
}

function ProRow({
  icon: Icon,
  title,
  note,
  locked,
  onClick
}: {
  icon: typeof Music
  title: string
  note: string
  locked: boolean
  onClick: () => void
}) {
  const body = (
    <>
      <Icon size={13} strokeWidth={1.7} className="mt-[2px] shrink-0 text-copper" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-label text-paper">{title}</span>
          {locked ? <ProChip /> : null}
        </span>
        <span className="mt-0.5 block text-meta leading-relaxed text-mist">
          {locked ? note : `${note} · 即将推出`}
        </span>
      </span>
    </>
  )

  if (!locked) {
    return <div className="flex items-start gap-2.5 rounded-surface border border-line px-2.5 py-2">{body}</div>
  }

  return (
    <button
      type="button"
      data-cuelume-press
      data-cuelume-release
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-surface border border-line px-2.5 py-2 text-left transition-[border-color,background-color,scale] duration-150 hover:border-copper/40 hover:bg-raised active:scale-[0.98]"
    >
      {body}
    </button>
  )
}

function readableURL(value: string): string {
  try {
    const url = new URL(value)
    return decodeURI(`${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`)
  } catch { return value }
}

function DetailValue({
  label, value, displayValue, copied, copyError, onCopy, onOpen, openLabel,
  openIcon: OpenIcon = ExternalLink, expandable = true
}: {
  label: string
  value: string
  displayValue?: string
  copied: boolean
  copyError?: string
  onCopy: () => void
  onOpen?: () => void
  openLabel?: string
  openIcon?: typeof ExternalLink
  expandable?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = textRef.current
    if (!element || expanded || !expandable) return
    const measure = (): void => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, expandable, value, displayValue])
  const content = <>
    <OpenIcon aria-hidden size={15} className="mt-0.5 shrink-0 text-mist" />
    <span ref={textRef} className={`min-w-0 flex-1 select-text ${expandable ? 'break-all' : '[overflow-wrap:anywhere]'} font-sans text-body leading-relaxed ${expandable && !expanded ? 'line-clamp-2' : ''}`}>
      {expanded ? value : displayValue || value}
    </span>
  </>
  return (
    <div className="inspector-detail-field" data-detail-field={label}>
      <div className="flex items-center justify-between gap-3">
        <span className="inspector-detail-label">{label}</span>
        <CopyFeedback copied={copied} error={copyError} onCopy={onCopy} />
      </div>
      {onOpen ? (
        <button type="button" onClick={onOpen}
          aria-label={openLabel ?? `打开${label}`} title={value}
          className="inspector-detail-value flex w-full items-start gap-2 rounded-control py-1 text-left text-fog transition-colors hover:bg-paper/[0.045] hover:text-paper focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20">
          {content}
        </button>
      ) : <div className="inspector-detail-value flex items-start gap-2 py-1 text-fog">{content}</div>}
      {expandable && (overflowing || expanded) ? (
        <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${label}`}
          onClick={() => setExpanded(!expanded)} className="inspector-detail-expand text-label text-mist hover:text-paper">
          {expanded ? '收起' : '展开'}
          <ChevronDown aria-hidden size={12} className={expanded ? 'rotate-180' : ''} />
        </button>
      ) : null}
    </div>
  )
}

function Action({
  icon: Icon,
  label,
  onClick,
  tone,
  variant = 'control',
  disabled = false,
  describedBy
}: {
  icon: typeof Pause
  label: string
  onClick?: () => void
  tone?: 'danger'
  variant?: 'control' | 'utility'
  disabled?: boolean
  describedBy?: string
}) {
  const danger = tone === 'danger'
  return (
    <button
      type="button"
      data-cuelume-press={danger ? 'droplet' : 'press'}
      data-cuelume-release
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
      className={
        variant === 'utility'
          ? `${UTILITY_ITEM_CLASS} ${danger ? 'text-mist hover:bg-clay/10 hover:text-clay' : 'text-fog hover:bg-paper/[0.05] hover:text-paper'}`
          : `${CONTROL_CLASS} ${danger ? 'text-mist hover:border-clay/25 hover:text-clay' : 'text-mist hover:border-line/70 hover:text-fog'}`
      }
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  )
}

/* The limit field speaks MB/s; the engine stores bytes per second. Keep both
   conversions in one place so a typed 2.5 comes back as 2.5, not 2.500001. */
function limitInputValue(bytes: number): string {
  if (!(bytes > 0)) return ''
  return String(Math.round((bytes / 1_048_576) * 100) / 100)
}

function limitLabel(bytes: number): string {
  return limitInputValue(bytes) || '0'
}

function parseLimitInput(text: string): { ok: true; bytes: number } | { ok: false } {
  const trimmed = text.trim().replace(',', '.')
  // Empty or 0 both mean "no per-task limit": follow the global setting.
  if (!trimmed || Number(trimmed) === 0) return { ok: true, bytes: 0 }
  const megabytes = Number(trimmed)
  if (!Number.isFinite(megabytes) || megabytes < BANDWIDTH_MIN_MB || megabytes > BANDWIDTH_MAX_MB) {
    return { ok: false }
  }
  return { ok: true, bytes: Math.round(megabytes * 1_048_576) }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function formatScheduleDate(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

function formatScheduleTime(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeScheduleDate(value: string): string {
  const cleaned = value.replace(/[^0-9/]/g, '').slice(0, 10)
  if (cleaned.includes('/')) return cleaned
  const digits = cleaned.replace(/\D/g, '')
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/')
}

function normalizeScheduleTime(value: string): string {
  const cleaned = value.replace(/[^0-9:]/g, '').slice(0, 5)
  if (cleaned.includes(':')) return cleaned
  const digits = cleaned.replace(/\D/g, '')
  return [digits.slice(0, 2), digits.slice(2, 4)].filter(Boolean).join(':')
}

function parseScheduleInput(dateValue: string, timeValue: string): number | null {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateValue)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue)
  if (!dateMatch || !timeMatch) return null
  const day = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const year = Number(dateMatch[3])
  const hours = Number(timeMatch[1])
  const minutes = Number(timeMatch[2])
  if (hours > 23 || minutes > 59) return null
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null
  return date.getTime()
}
