import { CalendarDays, Captions, Check, ChevronDown, ChevronRight, Clock3, Cloud, Copy, ExternalLink, Eye, FileText, FolderOpen, ImageIcon, Minus, Music, PackageOpen, Pause, Play, Plus, RefreshCcw, RotateCw, Share2, Trash2, VolumeX, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { formatByteProgress, formatBytes, formatDownloadTime, formatEta, fractionOf, isDiskImageFile, isDistinctTitle, remainingSeconds } from '../lib/format'
import {
  copyToClipboard,
  getCompletionStack,
  openExternal,
  openFile,
  quickLook,
  remove,
  renewTask,
  revealFile,
  scheduleTask,
  setTaskBandwidth,
  setTaskConnections,
  shareFile
} from '../lib/store'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type CompletionArtifact, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { requiresPro } from '../lib/license'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { FILE_MANAGER, IS_WINDOWS, TRASH_NAME } from '../lib/platform'
import { ProChip } from './ProChip'

const INSPECTOR_WIDTH_KEY = 'ndm.inspector.width'
const INSPECTOR_WIDTH_MIN = 320
const INSPECTOR_WIDTH_DEFAULT = 360
const INSPECTOR_WIDTH_MAX = 420

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

export function Inspector({
  task,
  onClose,
  onUpgrade,
  taskActionBusy,
  taskActionErrorId,
  onTaskToggle,
  onTaskRestart
}: {
  task: Task
  onClose: () => void
  onUpgrade: (reason: string) => void
  taskActionBusy: boolean
  taskActionErrorId?: string
  onTaskToggle: (task: Task) => void
  onTaskRestart: (task: Task) => void
}) {
  const fraction = fractionOf(task)
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const failed = task.status === 'error'
  const [copiedSource, setCopiedSource] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingTask, setDeletingTask] = useState(false)
  const [deleteTaskError, setDeleteTaskError] = useState('')
  const [showRenew, setShowRenew] = useState(false)
  const [renewURL, setRenewURL] = useState(task.url)
  const [renewError, setRenewError] = useState<string | null>(null)
  const [savingTaskConnections, setSavingTaskConnections] = useState(false)
  const [taskConnectionsError, setTaskConnectionsError] = useState('')
  const [savingTaskBandwidth, setSavingTaskBandwidth] = useState(false)
  const [taskBandwidthError, setTaskBandwidthError] = useState('')
  const [savingTaskSchedule, setSavingTaskSchedule] = useState(false)
  const [taskScheduleError, setTaskScheduleError] = useState('')
  const [scheduleInputInvalid, setScheduleInputInvalid] = useState(false)
  const [scheduleDate, setScheduleDate] = useState(() => formatScheduleDate(task.startAt))
  const [scheduleTime, setScheduleTime] = useState(() => formatScheduleTime(task.startAt))
  const [completionArtifacts, setCompletionArtifacts] = useState<CompletionArtifact[]>([])
  const [completionFilesExpanded, setCompletionFilesExpanded] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(storedInspectorWidth)
  const inspectorWidthRef = useRef(inspectorWidth)
  const stopInspectorResizeRef = useRef<(() => void) | null>(null)
  const thumbnail = useTaskThumbnail(task)
  const sourceURL = task.pageURL && task.pageURL !== task.url ? task.pageURL : null
  const customStartAt = parseScheduleInput(scheduleDate, scheduleTime)
  const summaryFacts = [
    { label: '状态', value: STATUS_LABEL[task.status], tone: completed ? 'success' : failed ? 'danger' : 'default' },
    task.phase ? { label: '阶段', value: PHASE_LABEL[task.phase], tone: 'default' } : null,
    { label: '类型', value: CATEGORY_LABEL[task.category], tone: 'default' },
    task.mediaOptions ? { label: '成品格式', value: task.mediaOptions.container === 'compactMKV' ? 'MKV · 紧凑' : 'MP4 · 兼容', tone: 'default' } : null,
    task.mediaOptions?.subtitleLanguage ? { label: '字幕', value: task.mediaOptions.subtitleLanguage, tone: 'default' } : null,
    { label: '大小', value: completed ? formatBytes(task.fileSize || task.completedBytes) : formatByteProgress(task.completedBytes, task.fileSize), tone: 'default' },
    !completed ? { label: '进度', value: `${Math.round(fraction * 100)}%`, tone: 'default' } : null,
    downloading ? { label: '剩余时间', value: formatEta(remainingSeconds(task)), tone: 'default' } : null,
    { label: '连接线程', value: `${task.connections} 个连接`, tone: 'default' },
    task.activityAt ? { label: '时间', value: formatDownloadTime(task.activityAt), tone: 'default' } : null,
    task.startAt ? { label: '定时开始', value: formatAppointment(task.startAt), tone: 'default' } : null
  ].filter((fact): fact is { label: string; value: string; tone: string } => fact != null)

  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth
  }, [inspectorWidth])

  useEffect(() => () => stopInspectorResizeRef.current?.(), [])

  useEffect(() => {
    setScheduleDate(formatScheduleDate(task.startAt))
    setScheduleTime(formatScheduleTime(task.startAt))
    setTaskScheduleError('')
    setScheduleInputInvalid(false)
  }, [task.id, task.startAt])

  useEffect(() => {
    setTaskConnectionsError('')
    setTaskBandwidthError('')
  }, [task.id])

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
  const installsApp = completed && !IS_WINDOWS && isDiskImageFile(filePath)

  const handleCopyLink = (): void => {
    void copyToClipboard(task.url).then(() => {
      cue('success')
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1500)
    })
  }

  const handleCopySource = (): void => {
    if (!sourceURL) return
    void copyToClipboard(sourceURL).then(() => {
      cue('success')
      setCopiedSource(true)
      setTimeout(() => setCopiedSource(false), 1500)
    })
  }

  const handleCopyPath = (): void => {
    void copyToClipboard(filePath).then(() => {
      cue('success')
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1500)
    })
  }

  const handleReveal = (): void => {
    void revealFile(filePath)
  }

  const handleOpen = (): void => {
    void openFile(filePath)
  }

  const handleRestart = (): void => {
    onTaskRestart(task)
  }

  const handleRenew = (): void => {
    const url = renewURL.trim()
    if (!/^https?:\/\//i.test(url)) {
      setRenewError('请输入完整的 HTTP 或 HTTPS 下载链接')
      return
    }
    setRenewError(null)
    void renewTask(task.id, url)
      .then(() => {
        cue('success')
        setShowRenew(false)
      })
      .catch((error: unknown) => setRenewError(error instanceof Error ? error.message : '更新链接失败'))
  }

  const handleTaskBandwidth = async (bandwidthLimit: number): Promise<void> => {
    if (savingTaskBandwidth) return
    setSavingTaskBandwidth(true)
    setTaskBandwidthError('')
    try {
      await setTaskBandwidth(task.id, bandwidthLimit)
      cue('toggle')
    } catch {
      setTaskBandwidthError('未能保存此任务的限速。请检查下载引擎后重试。')
    } finally {
      setSavingTaskBandwidth(false)
    }
  }

  const handleTaskConnections = async (connections: number): Promise<void> => {
    if (savingTaskConnections) return
    setSavingTaskConnections(true)
    setTaskConnectionsError('')
    try {
      await setTaskConnections(task.id, connections)
      cue('toggle')
    } catch {
      setTaskConnectionsError('未能保存此任务的连接数。请检查下载引擎后重试。')
    } finally {
      setSavingTaskConnections(false)
    }
  }

  const handleTaskSchedule = async (startAt: number | null): Promise<void> => {
    if (savingTaskSchedule) return
    setSavingTaskSchedule(true)
    setTaskScheduleError('')
    setScheduleInputInvalid(false)
    try {
      await scheduleTask(task.id, startAt)
      cue('toggle')
    } catch {
      setTaskScheduleError('未能保存此任务的预约。请检查下载引擎后重试。')
    } finally {
      setSavingTaskSchedule(false)
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

  const handlePresetSchedule = (startAt: number | null): void => {
    // A preset supersedes any custom draft. Keep the fields aligned with the
    // durable appointment until the engine confirms and broadcasts the new one.
    setScheduleDate(formatScheduleDate(task.startAt))
    setScheduleTime(formatScheduleTime(task.startAt))
    void handleTaskSchedule(startAt)
  }

  const handleDelete = async (deleteFile: boolean): Promise<void> => {
    if (deletingTask) return
    setDeletingTask(true)
    setDeleteTaskError('')
    try {
      await remove(task.id, deleteFile)
      cue('success')
      setShowDeleteConfirm(false)
      onClose()
    } catch {
      setDeleteTaskError(deleteFile
        ? `未能删除任务或将文件移到${TRASH_NAME}。请检查下载引擎后重试。`
        : '未能从列表移除任务。请检查下载引擎后重试。')
    } finally {
      setDeletingTask(false)
    }
  }

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
    const startWidth = inspectorWidthRef.current
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
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidthRef.current))
      stopInspectorResizeRef.current = null
    }

    stopInspectorResizeRef.current = stopResize
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
      className="t-panel-slide relative flex shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: inspectorWidth }}
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
        onKeyDown={handleInspectorResizeKey}
        className="group/resize absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize focus-visible:outline-none"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-paper/25 group-focus-visible/resize:bg-paper/35" />
      </div>
      <span aria-hidden className="app-drag absolute inset-x-0 top-0 z-10 h-[44px]" />
      <div className="flex items-center justify-between px-5 pb-3 pt-[56px]">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">任务详情</div>
        <button
          type="button"
          data-cuelume-press="tick"
          onClick={onClose}
          className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6 scroll-quiet">
        <h2 className="line-clamp-3 break-words font-serif text-[22px] leading-snug" title={task.filename || task.title}>
          {task.filename || task.title}
        </h2>
        {isDistinctTitle(task.title, task.filename) ? (
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-mist">{task.title}</p>
        ) : null}

        {thumbnail ? (
          <figure className="media-thumbnail mt-3 overflow-hidden rounded-[12px] bg-ink/35">
            <div className="aspect-video">
              <img
                src={thumbnail}
                alt={`${task.title || task.filename} 的预览图`}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className="t-skel-content h-full w-full object-cover"
                draggable={false}
              />
            </div>
          </figure>
        ) : null}

        <div className="mt-4 space-y-3">
          {sourceURL ? (
            <DetailValue
              label="来源网页"
              value={sourceURL}
              copied={copiedSource}
              onCopy={handleCopySource}
              onOpen={() => void openExternal(sourceURL)}
              openLabel="在浏览器中打开来源网页"
            />
          ) : null}
          <DetailValue
            label="下载链接"
            value={task.url}
            copied={copiedLink}
            onCopy={handleCopyLink}
            onOpen={() => void openExternal(task.url)}
            openLabel="在浏览器中打开下载链接"
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-y-2 text-[12.5px] leading-none" aria-label="任务概要">
          {summaryFacts.map((fact, index) => (
            <span key={fact.label} className="contents">
              {index > 0 ? <span aria-hidden className="mx-2 text-line-strong">·</span> : null}
              <span
                aria-label={`${fact.label}：${fact.value}`}
                title={`${fact.label}：${fact.value}`}
                className={fact.tone === 'success' ? 'text-sage' : fact.tone === 'danger' ? 'text-clay' : 'text-fog'}
              >
                {fact.value}
              </span>
            </span>
          ))}
        </div>
        {task.deliveryNote ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-copper/30 bg-copper/10 px-3 py-2.5">
            <VolumeX size={15} className="mt-0.5 shrink-0 text-copper" strokeWidth={1.7} />
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-copper">{task.deliveryNote.title}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-fog">{task.deliveryNote.detail}</p>
            </div>
          </div>
        ) : null}
        <div className="mt-3 border-t border-line/60 pt-3">
          <DetailValue
            label="存储位置"
            value={filePath}
            copied={copiedPath}
            onCopy={handleCopyPath}
            onOpen={handleReveal}
            openLabel={`在${FILE_MANAGER}中显示存储位置`}
            openIcon={FolderOpen}
          />
        </div>

        {completed && completionArtifacts.length > 1 ? (
          <CompletionFiles
            artifacts={completionArtifacts}
            expanded={completionFilesExpanded}
            onToggle={() => setCompletionFilesExpanded((value) => !value)}
          />
        ) : null}

        {COMMERCIALIZATION_DRAFT_ENABLED ? (
          <div className="mt-5 space-y-2 border-t border-line/60 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">后期与同步</p>
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
          <div className="mt-5 space-y-3 border-t border-line/60 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">调节</p>
            <div
              role="group"
              aria-label="任务连接数"
              aria-busy={savingTaskConnections}
              aria-describedby={taskConnectionsError ? 'task-connections-status' : undefined}
              data-task-connections={task.connections}
              className="flex items-center justify-between gap-3"
            >
              <div>
                <div className="text-[12.5px] text-paper">连接数</div>
                <p className="mt-0.5 text-[10.5px] text-mist">确认能分段后按原版尽快加到这个上限</p>
                <p
                  id="task-connections-status"
                  role="status"
                  aria-live="polite"
                  className={taskConnectionsError ? 'mt-1 text-[10.5px] text-clay' : 'sr-only'}
                >
                  {taskConnectionsError}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={savingTaskConnections || task.connections <= 1}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mist hover:border-line-strong hover:text-paper disabled:cursor-wait disabled:opacity-45"
                  onClick={() => void handleTaskConnections(Math.max(1, task.connections - 1))}
                  aria-label="减少连接"
                >
                  <Minus size={12} />
                </button>
                <span className="w-6 text-center font-mono text-[12px] tabular-nums">{task.connections}</span>
                <button
                  type="button"
                  disabled={savingTaskConnections || task.connections >= 32}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mist hover:border-line-strong hover:text-paper disabled:cursor-wait disabled:opacity-45"
                  onClick={() => void handleTaskConnections(Math.min(32, task.connections + 1))}
                  aria-label="增加连接"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div>
              <div className="text-[12.5px] text-paper">此任务限速</div>
              <p className="mt-0.5 text-[10.5px] text-mist">不覆盖全局上限；正在传输的任务从下一轮开始生效</p>
              <p
                id="task-bandwidth-status"
                role="status"
                aria-live="polite"
                className={taskBandwidthError ? 'mt-1.5 text-[10.5px] text-clay' : 'sr-only'}
              >
                {taskBandwidthError}
              </p>
              <div
                role="group"
                aria-label="此任务限速"
                aria-busy={savingTaskBandwidth}
                aria-describedby={taskBandwidthError ? 'task-bandwidth-status' : undefined}
                className="mt-2 flex flex-wrap gap-1.5"
              >
                {[
                  { label: '不限速', val: 0 },
                  { label: '1 MB/s', val: 1_048_576 },
                  { label: '5 MB/s', val: 5_242_880 },
                  { label: '10 MB/s', val: 10_485_760 }
                ].map((tier) => {
                  const current = task.bandwidthLimit ?? 0
                  const active = current === tier.val
                  return (
                    <button
                      key={tier.label}
                      type="button"
                      disabled={savingTaskBandwidth}
                      aria-pressed={active}
                      onClick={() => void handleTaskBandwidth(tier.val)}
                      className={`rounded-md px-2 py-1 text-[11px] disabled:cursor-wait disabled:opacity-55 ${
                        active
                          ? 'bg-copper text-on-accent'
                          : 'border border-line text-mist hover:border-line-strong hover:text-paper'
                      }`}
                    >
                      {tier.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div
              role="group"
              aria-label="定时开始"
              aria-busy={savingTaskSchedule}
              aria-describedby={taskScheduleError ? 'task-schedule-status' : undefined}
              data-task-start-at={task.startAt ?? ''}
            >
              <div className="text-[12.5px] text-paper">定时开始</div>
              <p className="mt-0.5 text-[10.5px] text-mist">到点会自动从等待变为下载</p>
              <p
                id="task-schedule-status"
                role="status"
                aria-live="polite"
                className={taskScheduleError ? 'mt-1.5 text-[10.5px] text-clay' : 'sr-only'}
              >
                {taskScheduleError}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={savingTaskSchedule}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-mist hover:text-paper disabled:cursor-wait disabled:opacity-55"
                  onClick={() => handlePresetSchedule(Date.now() + 60 * 60 * 1000)}
                >
                  1 小时后
                </button>
                <button
                  type="button"
                  disabled={savingTaskSchedule}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-mist hover:text-paper disabled:cursor-wait disabled:opacity-55"
                  onClick={() => handlePresetSchedule(tonightAt(23, 0))}
                >
                  今晚 23:00
                </button>
                {task.startAt ? (
                  <button
                    type="button"
                    disabled={savingTaskSchedule}
                    className="rounded-md border border-line px-2 py-1 text-[11px] text-clay hover:bg-clay/10 disabled:cursor-wait disabled:opacity-55"
                    onClick={() => handlePresetSchedule(null)}
                  >
                    清除预约
                  </button>
                ) : null}
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_auto] gap-1.5">
                <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] border border-line bg-panel/55 px-2 focus-within:border-copper/60">
                  <CalendarDays size={13} className="shrink-0 text-mist" />
                  <input
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
                    disabled={savingTaskSchedule}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] tabular-nums text-paper outline-none placeholder:text-mist/60 disabled:cursor-wait disabled:opacity-55"
                  />
                </label>
                <label className="flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-panel/55 px-2 focus-within:border-copper/60">
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
                    disabled={savingTaskSchedule}
                    className="w-full min-w-0 bg-transparent font-mono text-[11.5px] tabular-nums text-paper outline-none placeholder:text-mist/60 disabled:cursor-wait disabled:opacity-55"
                  />
                </label>
                <button
                  type="button"
                  disabled={savingTaskSchedule}
                  onClick={handleCustomSchedule}
                  className="h-8 rounded-[8px] border border-line px-2.5 text-[11.5px] text-copper transition-[background-color,color,scale] duration-100 hover:bg-copper/10 active:scale-[0.96] disabled:cursor-default disabled:text-mist/45 disabled:hover:bg-transparent"
                >
                  预约
                </button>
              </div>
              <p className="mt-1.5 text-[10.5px] text-mist">日期按日／月／年填写，时间使用 24 小时制</p>
            </div>
          </div>
        ) : null}

        {failed && task.errorText ? (
          <div className="mt-4 rounded-lg border border-clay/30 bg-clay/10 px-3 py-2.5">
            <p className="text-[12px] font-medium text-clay">{task.diagnostic?.title || '下载失败'}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              {task.diagnostic?.message || task.errorText}
            </p>
            {showRenew ? (
              <div className="mt-2.5 border-t border-clay/20 pt-2.5">
                <input
                  autoFocus
                  value={renewURL}
                  onChange={(event) => {
                    setRenewURL(event.target.value)
                    setRenewError(null)
                  }}
                  className="w-full rounded-md border border-line-strong bg-ink/45 px-2 py-1.5 font-mono text-[10.5px] text-paper outline-none focus:border-copper/60"
                  aria-label="新的下载链接"
                  spellCheck={false}
                />
                {renewError ? <p className="mt-1 text-[10.5px] text-clay">{renewError}</p> : null}
                <div className="mt-2 flex justify-end gap-2 text-[11px]">
                  <button type="button" onClick={() => setShowRenew(false)} className="text-mist hover:text-paper">取消</button>
                  <button type="button" onClick={handleRenew} className="rounded-md bg-copper px-2.5 py-1 font-medium text-on-accent">更新并继续</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

      </div>

      {/* Delete confirmation dialog overlay */}
      {showDeleteConfirm ? (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-ink/75 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            aria-busy={deletingTask}
            className="rounded-xl border border-line-strong bg-raised p-4 shadow-xl"
          >
            <h4 id="delete-task-title" className="text-[13px] font-medium text-paper">确定删除下载？</h4>
            <p className="mt-1 text-[11.5px] text-mist">您可以选择仅从列表中移除任务，或将已下载文件移到{TRASH_NAME}。</p>
            <p
              id="task-delete-status"
              role="status"
              aria-live="polite"
              className={deleteTaskError ? 'mt-2 text-[11px] text-clay' : 'sr-only'}
            >
              {deleteTaskError}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={deletingTask}
                onClick={() => void handleDelete(false)}
                className="w-full rounded-lg border border-line py-1.5 text-[12px] text-fog transition-colors hover:bg-line hover:text-paper disabled:cursor-wait disabled:opacity-55"
              >
                仅从列表移除
              </button>
              <button
                type="button"
                disabled={deletingTask}
                onClick={() => void handleDelete(true)}
                className="w-full rounded-lg bg-clay/15 py-1.5 text-[12px] font-medium text-clay transition-colors hover:bg-clay/25 disabled:cursor-wait disabled:opacity-55"
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
                className="w-full py-1 text-[11.5px] text-mist hover:text-paper disabled:cursor-wait disabled:opacity-55"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`grid ${completed ? (IS_WINDOWS ? 'grid-cols-4' : 'grid-cols-5') : 'grid-cols-3'} gap-1.5 border-t border-line p-3`}>
        {completed ? (
          <Action icon={Eye} label="预览" onClick={() => void quickLook(filePath)} />
        ) : failed ? (
          task.diagnostic?.primaryAction === 'openPage' && task.pageURL ? (
            <Action icon={ExternalLink} label="浏览器" onClick={() => void openExternal(task.pageURL!)} />
          ) : task.diagnostic?.primaryAction === 'renew' ? (
            <Action icon={RotateCw} label="更新" onClick={() => setShowRenew(true)} />
          ) : (
            <Action icon={RotateCw} label="重试" disabled={taskActionBusy} describedBy={taskActionErrorId} onClick={handleRestart} />
          )
        ) : (
          <Action
            icon={downloading ? Pause : Play}
            label={downloading ? '暂停' : '继续'}
            disabled={taskActionBusy}
            describedBy={taskActionErrorId}
            onClick={() => onTaskToggle(task)}
          />
        )}
        <Action icon={FolderOpen} label={FILE_MANAGER} onClick={handleReveal} />
        {completed ? (
          <Action
            icon={installsApp ? PackageOpen : ExternalLink}
            label={installsApp ? '安装' : '打开'}
            onClick={handleOpen}
          />
        ) : null}
        {completed && !IS_WINDOWS ? <Action icon={Share2} label="分享" onClick={() => void shareFile(filePath)} /> : null}
        <Action
          icon={Trash2}
          label="删除"
          tone="danger"
          onClick={() => {
            setDeleteTaskError('')
            setShowDeleteConfirm(true)
          }}
        />
      </div>
    </aside>
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
    <section className="mt-5 border-t border-line/60 pt-4" aria-label="完成文件">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 rounded-[9px] py-1 text-left"
      >
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-paper">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          完成文件
        </span>
        <span className="text-[10.5px] text-mist">{summary}</span>
      </button>
      {expanded ? (
        <div
          className="mt-2 overflow-hidden rounded-[10px] border border-line/70"
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
                <span className="block truncate text-[11.5px] text-paper" title={artifact.name}>{artifact.name}</span>
                <span className="mt-0.5 block text-[10px] text-mist">
                  {completionArtifactLabel(artifact.kind)}{artifact.byteCount > 0 ? ` · ${formatBytes(artifact.byteCount)}` : ''}
                </span>
              </span>
              <button
                type="button"
                aria-label={`打开 ${artifact.name}`}
                title="打开"
                onClick={() => void openFile(artifact.path)}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] text-mist hover:bg-raised hover:text-paper"
              >
                <ExternalLink size={13} />
              </button>
              <button
                type="button"
                aria-label={`在${FILE_MANAGER}中显示 ${artifact.name}`}
                title={`在${FILE_MANAGER}中显示`}
                onClick={() => void revealFile(artifact.path)}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] text-mist hover:bg-raised hover:text-paper"
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
          <span className="min-w-0 truncate text-[12.5px] text-paper">{title}</span>
          {locked ? <ProChip /> : null}
        </span>
        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-mist">
          {locked ? note : `${note} · 即将推出`}
        </span>
      </span>
    </>
  )

  if (!locked) {
    return <div className="flex items-start gap-2.5 rounded-lg border border-line px-2.5 py-2">{body}</div>
  }

  return (
    <button
      type="button"
      data-cuelume-press
      data-cuelume-release
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left transition-[border-color,background-color,scale] duration-150 hover:border-copper/40 hover:bg-raised active:scale-[0.98]"
    >
      {body}
    </button>
  )
}

function DetailValue({
  label,
  value,
  copied,
  onCopy,
  onOpen,
  openLabel,
  openIcon: OpenIcon = ExternalLink
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  onOpen?: () => void
  openLabel?: string
  openIcon?: typeof ExternalLink
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-mist">{label}</span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onCopy}
            className={`inline-flex items-center gap-1 text-[11.5px] transition-colors duration-100 hover:text-paper ${copied ? 'text-sage' : 'text-copper'}`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel ?? `打开${label}`}
          title={`${openLabel ?? `打开${label}`}\n${value}`}
          className="group/value -mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-[8px] px-2 py-1 text-left text-fog transition-[background-color,color] duration-150 hover:bg-paper/[0.045] hover:text-paper focus-visible:bg-paper/[0.045] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20"
        >
          <span className="line-clamp-2 min-h-[2.5rem] max-h-[2.5rem] min-w-0 flex-1 select-text overflow-hidden break-all font-mono text-[11.5px] leading-5">
            {value}
          </span>
          <OpenIcon
            aria-hidden
            size={12}
            className="mt-1 shrink-0 text-mist opacity-55 transition-[opacity,transform] duration-150 group-hover/value:translate-x-0.5 group-hover/value:opacity-100 group-focus-visible/value:opacity-100"
          />
        </button>
      ) : (
        <div className="line-clamp-2 min-h-[2.5rem] max-h-[2.5rem] select-text overflow-hidden break-all font-mono text-[11.5px] leading-5 text-fog" title={value}>
          {value}
        </div>
      )}
    </div>
  )
}

function Action({
  icon: Icon,
  label,
  onClick,
  tone,
  disabled = false,
  describedBy
}: {
  icon: typeof Pause
  label: string
  onClick?: () => void
  tone?: 'danger'
  disabled?: boolean
  describedBy?: string
}) {
  return (
    <button
      type="button"
      data-cuelume-press={tone === 'danger' ? 'droplet' : 'press'}
      data-cuelume-release
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1 rounded-[8px] border border-transparent py-2 text-[11px] transition-[color,background-color,border-color,scale] duration-150 active:scale-[0.97] hover:bg-paper/[0.045] disabled:cursor-wait disabled:opacity-50 ${
        tone === 'danger' ? 'text-clay/85 hover:border-clay/25 hover:text-clay' : 'text-mist hover:border-line/70 hover:text-fog'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
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

function tonightAt(hours: number, minutes: number): number {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1)
  return date.getTime()
}

function formatAppointment(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
