import { taskNextAction } from './lib/taskNextAction'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Copy, Pause, Play, Trash2, X, ArrowDown, CircleAlert } from 'lucide-react'
import { ClipboardToast } from './components/ClipboardToast'
import { CleanupModal } from './components/CleanupModal'
import { TransferActivity, type CompletionNotice, type InstallProgressPhase, type InstallProgressState } from './components/TransferActivity'
import { Composer } from './components/Composer'
import { CommandPalette, type CommandPaletteItem } from './components/CommandPalette'
import { ContextMenu, type ContextMenuPosition } from './components/ContextMenu'
import { DestinationDialog } from './components/DestinationDialog'
import { DeleteTasksDialog } from './components/DeleteTasksDialog'
import { Hero } from './components/Hero'
import { Inspector } from './components/Inspector'
import { Onboarding } from './components/Onboarding'
import { Confetti, type ConfettiRef } from './components/ui/confetti'
import { MetalForgePreview } from './effects/metalforge/MetalForgePreview'
import { ProductMotionLab } from './effects/metalforge/ProductMotion'
import { ProModal } from './components/ProModal'
import { Settings } from './components/Settings'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { Sidebar } from './components/Sidebar'
import { VirtualTaskList } from './components/VirtualTaskList'
import { EmptyState } from './components/EmptyState'
import { LibraryToolbar } from './components/LibraryToolbar'
import { TemporaryBandwidth, temporaryBandwidthLabel } from './components/TemporaryBandwidth'
import { useTemporaryBandwidth } from './lib/useTemporaryBandwidth'
import { TransferControl } from './components/TransferControl'
import { SelectionActions } from './components/SelectionActions'
import { LibraryViewControls, LibraryViewSummary } from './components/LibraryViewControls'
import { SavedViewsDialog } from './components/SavedViewsDialog'
import { useSavedViews, useViewClock } from './lib/useSavedViews'
import { criteriaWithSidebarFilter, DEFAULT_VIEW_CRITERIA, filterTasksForView, primaryFilterForView, savedViewMatches, type LibraryViewCriteria, type SavedView } from './lib/savedViews'
import { isEditableTarget, moveSelection, selectionRange, workspaceHero } from './lib/workspace'
import { Gallery } from './Gallery'
import { runFileDeliveryAction } from './lib/fileDelivery'
import { formatSpeed } from './lib/format'
import { dragCarriesDownloadLink, resolveDroppedInput } from './lib/dropInput'
import { browserMediaSessionFromEvent, type BrowserMediaSession } from './lib/browserMediaSession'
import { isKnownMediaSiteURL } from './lib/sharedLink'
import { cue } from './lib/sound'
import {
  getTasks,
  getTaskPauseTargets,
  copyToClipboard,
  addFromUrl,
  installDiskImage,
  openFile,
  openExternal,
  pauseAll,
  quickLook,
  removeMany,
  restartMany,
  restartTask,
  retryEngine,
  revealFile,
  shareFile,
  toggle,
  setTaskPaused
} from './lib/store'
import { useClipboardOffer } from './lib/useClipboardOffer'
import { COMMERCIALIZATION_DRAFT_ENABLED } from './lib/commercialization'
import { hasOnboarded, markOnboarded, resetOnboarding } from './lib/onboarding'
import { readStoredTheme, themeById, writeStoredTheme, type ThemeId } from './lib/themes'
import { buildDisplayItems, readTaskSort, sortTasks, visualTasks, writeTaskSort, type TaskSort, type TaskSortKey } from './lib/taskList'
import type { FilterId, Task } from './lib/types'
import { COMMAND_KEY, FILE_MANAGER, IS_WINDOWS } from './lib/platform'
import { useLibraryReady, useEngineError, useEngineStatus, useTasks } from './lib/useStore'

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

export default function App() {
  const query = params()
  const gallery = query.get('gallery') === '1'
  const embed = query.get('embed') === '1'
  const fxMode = query.get('fx')
  const fxPreview = fxMode === '1' || fxMode === 'product'
  const [themeId, setThemeId] = useState<ThemeId>(() => themeById(query.get('theme') ?? readStoredTheme()).id)
  const theme = themeById(themeId)

  useEffect(() => {
    document.documentElement.dataset.platform = window.ndm?.platform ?? 'web'
    document.documentElement.dataset.theme = gallery ? 'walnut' : theme.id
    document.title = fxPreview ? 'NDM · 动效预览' : gallery ? 'NDM · 选方向' : `NDM · ${theme.name}`
    window.ndm?.setWindowTheme?.(gallery || fxPreview ? 'gallery' : theme.id)
    if (!gallery && !embed && !fxPreview) writeStoredTheme(theme.id)
  }, [gallery, embed, theme.id, fxPreview])

  const applyTheme = (id: ThemeId): void => {
    setThemeId(id)
    writeStoredTheme(id)
    const next = new URL(window.location.href)
    next.searchParams.delete('gallery')
    next.searchParams.set('theme', id)
    history.replaceState(null, '', next)
  }

  if (fxMode === 'product') return <ProductMotionLab />
  if (fxPreview) return <MetalForgePreview />
  if (gallery) return <Gallery />
  return <Shell themeId={theme.id} embed={embed} onTheme={applyTheme} />
}

function Shell({
  themeId,
  embed,
  onTheme
}: {
  themeId: ThemeId
  embed: boolean
  onTheme: (id: ThemeId) => void
}) {
  const tasks = useTasks()
  const temporaryBandwidth = useTemporaryBandwidth(!IS_WINDOWS)
  const libraryReady = useLibraryReady()
  const engineStatus = useEngineStatus()
  const engineError = useEngineError()
  const [criteria, setCriteria] = useState<LibraryViewCriteria>(() => ({ ...DEFAULT_VIEW_CRITERIA }))
  const filter = primaryFilterForView(criteria)
  const query = criteria.query
  const setFilter = (id: FilterId): void => setCriteria(current => criteriaWithSidebarFilter(current, id))
  const setQuery = (query: string): void => setCriteria(current => ({ ...current, query }))
  const savedViews = useSavedViews()
  const [savedViewsOpen, setSavedViewsOpen] = useState(false)
  const [viewControlsOpen, setViewControlsOpen] = useState(false)
  const [activeSavedViewID, setActiveSavedViewID] = useState<string | null>(null)
  const viewNow = useViewClock(criteria.time)
  const [taskSort, setTaskSort] = useState<TaskSort>(readTaskSort)
  const activeSavedView = savedViews.views.find(view => view.id === activeSavedViewID && savedViewMatches(view, criteria, taskSort))
  const [spotlightTaskID, setSpotlightTaskID] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [sidebarMode, setSidebarMode] = useState<'auto' | 'open' | 'closed'>('auto')
  const [dismissedInspector, setDismissedInspector] = useState<number | null>(null)
  const selectionAnchor = useRef<number | null>(null)
  const selectionFocus = useRef<number | null>(null)
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(composing)
  composingRef.current = composing
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const [composerBrowserSession, setComposerBrowserSession] = useState<BrowserMediaSession | null>(null)
  const [settings, setSettingsState] = useState(false)
  // Only the latest interaction may present UI. Independent file requests
  // retain their download intent even after they lose presentation ownership.
  const mediaPresentationEpoch = useRef(0)
  const setSettings = (value: boolean | ((open: boolean) => boolean)): void => {
    mediaPresentationEpoch.current += 1
    setSettingsState(value)
  }
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  // Retain the commercial UI draft without presenting it in the open Beta.
  const [proReason, setProReason] = useState<string | null>(null)
  const [proOpen, setProOpen] = useState(false)
  const [proRedeem, setProRedeem] = useState(false)
  const [onboarding, setOnboarding] = useState(() => !embed && !hasOnboarded())
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ ids: number[]; preferredDeleteFile: boolean } | null>(null)
  const [deletingPendingTasks, setDeletingPendingTasks] = useState(false)
  const [pendingDeleteError, setPendingDeleteError] = useState('')
  // Dismissing the engine banner is scoped to the exact failure message: the
  // same error stays hidden for the session, but a different message (or a
  // fresh failure after the engine recovered) must surface again.
  const [dismissedEngineError, setDismissedEngineError] = useState<string | null>(null)
  const [libraryActionError, setLibraryActionError] = useState('')
  const [taskAction, setTaskAction] = useState<{ taskID: number; kind: 'toggle' | 'restart' | 'schedule' | 'delete' } | null>(null)
  const [taskActionError, setTaskActionError] = useState('')
  const [previewNotice, setPreviewNotice] = useState<{ message: string } | null>(null)
  useEffect(() => window.ndm?.onFileDragError?.(message => setPreviewNotice({ message })), [])
  const previewRequest = useRef(0)
  useEffect(() => {
    if (!previewNotice) return
    const timer = window.setTimeout(() => setPreviewNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [previewNotice])
  const taskActionBusyRef = useRef(false)
  const libraryActionRef = useRef(false)
  const batchTaskBusyRef = useRef(false)
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null)
  const [celebratingIds, setCelebratingIds] = useState<Set<number>>(new Set())
  const knownStatuses = useRef<Map<number, Task['status']>>(new Map())
  const celebrationTimers = useRef<Map<number, number>>(new Map())
  const confettiRef = useRef<ConfettiRef | null>(null)
  const quietCompletion = composing || settings || onboarding || Boolean(pendingDelete) || commandsOpen || savedViewsOpen || cleanupOpen
  useEffect(() => { if (quietCompletion) confettiRef.current?.clear() }, [quietCompletion])
  const clipboard = useClipboardOffer(tasks, composing, !onboarding)

  const [destinationTaskID, setDestinationTaskID] = useState<number | null>(null)
  const promptedDestinations = useRef(new Set<number>())
  const destinationTask = tasks.find(task => task.id === destinationTaskID && task.awaitingDestination)
  useEffect(() => {
    if (destinationTaskID !== null) {
      if (!destinationTask) setDestinationTaskID(null)
      return
    }
    if (composing || settings || onboarding || pendingDelete || cleanupOpen || proOpen || shortcutsOpen || commandsOpen || savedViewsOpen || viewControlsOpen || contextMenu) return
    const next = tasks.find(task => task.awaitingDestination && !promptedDestinations.current.has(task.id))
    if (next) { promptedDestinations.current.add(next.id); setDestinationTaskID(next.id) }
  }, [tasks, destinationTaskID, destinationTask, composing, settings, onboarding, pendingDelete, cleanupOpen, proOpen, shortcutsOpen, commandsOpen, savedViewsOpen, viewControlsOpen, contextMenu])
  const closeDestination = (id: number): void => setDestinationTaskID(current => current === id ? null : current)

  const runTaskAction = useCallback(async (task: Task, kind: 'toggle' | 'restart'): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) return
    const current = getTasks().find(candidate => candidate.id === task.id)
    if (!current) return
    task = current
    if (task.awaitingDestination) { promptedDestinations.current.add(task.id); setDestinationTaskID(task.id); return }
    if (task.status === 'error') kind = 'restart'
    taskActionBusyRef.current = true
    setTaskAction({ taskID: task.id, kind })
    setTaskActionError('')
    setLibraryActionError('')
    try {
      if (kind === 'restart') await restartTask(task.id)
      else await toggle(task.id)
      cue('success')
    } catch {
      const verb = kind === 'restart' ? '重试' : task.status === 'downloading' || task.status === 'waiting' ? task.isLiveRecording ? '停止并保存' : '暂停' : '继续'
      setTaskActionError(`未能${verb}“${task.filename || task.title}”。请重试。`)
      cue('droplet')
    } finally {
      taskActionBusyRef.current = false
      setTaskAction(null)
    }
  }, [])

  const runInspectorAction = useCallback(async (task: Task, operation: () => Promise<void>, kind: 'schedule' | 'delete'): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) {
      throw new Error('另一个任务操作正在进行，请稍后重试。')
    }
    if (!getTasks().some(candidate => candidate.id === task.id)) throw new Error('任务已不在列表中。')
    // Hold the lock across the complete Inspector operation and its final receipt.
    taskActionBusyRef.current = true
    setTaskAction({ taskID: task.id, kind })
    setTaskActionError('')
    setLibraryActionError('')
    try {
      await operation()
    } finally {
      taskActionBusyRef.current = false
      setTaskAction(null)
    }
  }, [])

  const visible = useMemo(() => filterTasksForView(tasks, criteria, Date.now()), [criteria, tasks, viewNow])
  const sortedVisible = useMemo(() => sortTasks(visible, taskSort), [taskSort, visible])
  const heroScope = sortedVisible
  const activeHeroCandidates = heroScope.filter((task) => task.status === 'downloading')
  const hero = workspaceHero(heroScope, filter, query, spotlightTaskID)
  const heroCycleCandidates = hero
    ? hero.status === 'downloading'
      ? activeHeroCandidates
      : [hero, ...activeHeroCandidates.filter((task) => task.id !== hero.id)]
    : []
  const heroPosition = hero ? heroCycleCandidates.findIndex((task) => task.id === hero.id) : -1

  useEffect(() => {
    if (hero && hero.id !== spotlightTaskID) setSpotlightTaskID(hero.id)
    else if (!hero && spotlightTaskID != null) setSpotlightTaskID(null)
  }, [hero?.id, spotlightTaskID])

  const rest = useMemo(() => sortedVisible.filter((task) => task.id !== hero?.id), [sortedVisible, hero?.id])
  // Reveal matching collection children while searching without changing the saved expansion state.
  const displayedCollections = useMemo(() => query.trim()
    ? new Set([...expandedCollections, ...sortedVisible.flatMap((task) => task.collection ? [task.collection.id] : [])])
    : expandedCollections, [query, sortedVisible, expandedCollections])
  const visibleRows = useMemo(
    () => visualTasks(buildDisplayItems(rest, tasks, displayedCollections)),
    [displayedCollections, rest, tasks]
  )

  const keyboardTasks = useMemo(() => hero ? [hero, ...visibleRows] : visibleRows, [hero, visibleRows])

  const changeQuery = (value: string): void => {
    setQuery(value)
    setSelectedIds(new Set())
    selectionAnchor.current = null
    selectionFocus.current = null
    setContextMenu(null)
  }

  const changeCriteria = (value: LibraryViewCriteria): void => {
    setCriteria(value)
    setSelectedIds(new Set())
    selectionAnchor.current = null
    selectionFocus.current = null
    setContextMenu(null)
  }
  const applySavedView = (view: SavedView): void => {
    changeCriteria({ ...view.criteria })
    setTaskSort({ ...view.sort })
    setActiveSavedViewID(view.id)
    setSavedViewsOpen(false)
  }

  // Single active selected task for Inspector
  const singleSelectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const selectedTask = singleSelectedId !== null ? (visible.find((task) => task.id === singleSelectedId) ?? null) : null
  useEffect(() => {
    previewRequest.current++
    setPreviewNotice(null)
    return () => { previewRequest.current++ }
  }, [selectedTask?.id])

  const handleTaskSort = (key: TaskSortKey): void => {
    setTaskSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'filename' || key === 'status' ? 'asc' : 'desc' })
  }

  useEffect(() => {
    writeTaskSort(taskSort)
  }, [taskSort])

  // Detect completion across presentation changes (Hero -> list row). Keeping this
  // above TaskRow avoids replaying the animation when a virtual row remounts.
  useEffect(() => {
    const previous = knownStatuses.current
    const next = new Map(tasks.map((task) => [task.id, task.status] as const))
    knownStatuses.current = next
    if (previous.size === 0) return

    const completed = tasks.filter(
      (task) => task.status === 'complete' && previous.get(task.id) !== undefined && previous.get(task.id) !== 'complete'
    )
    if (completed.length === 0) return

    // Keep the ceremony quiet, but let it use the whole window: density and
    // duration create restraint, not a visibly clipped celebration box.
    if (!quietCompletion) confettiRef.current?.fire({
      particleCount: 64,
      spread: 360,
      startVelocity: 28,
      gravity: 0.72,
      decay: 0.93,
      scalar: 0.82,
      ticks: 150,
      origin: { x: 0.5, y: 0.52 },
      colors: ['#d79343', '#b97129', '#f7efe2', '#91ad7d'],
      disableForReducedMotion: true
    })

    setCelebratingIds((current) => new Set([...current, ...completed.map((task) => task.id)]))
    for (const task of completed) {
      const existing = celebrationTimers.current.get(task.id)
      if (existing) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        setCelebratingIds((current) => {
          const updated = new Set(current)
          updated.delete(task.id)
          return updated
        })
        celebrationTimers.current.delete(task.id)
      }, 700)
      celebrationTimers.current.set(task.id, timer)
    }
  }, [tasks, quietCompletion])

  useEffect(
    () => () => {
      for (const timer of celebrationTimers.current.values()) window.clearTimeout(timer)
    },
    []
  )

  // Clipboard link sniffer on window focus. The same shared-link resolver as
  // the composer, so 分享口令 triggers the toast like a bare media URL.
  // Each pasteboard generation is offered at most once; "添加下载" consumes it.

  const openComposer = (prefillUrl?: string): void => {
    mediaPresentationEpoch.current += 1
    if (!prefillUrl) void clipboard.consumeGeneration()
    setComposerPrefill(prefillUrl ?? null)
    setComposerBrowserSession(null)
    setComposing(true)
    setCommandsOpen(false)
    setSettings(false)
    setContextMenu(null)
    cue('bloom')
  }

  const closeComposer = (): void => {
    mediaPresentationEpoch.current += 1
    setComposing(false)
    setComposerPrefill(null)
    setComposerBrowserSession(null)
  }

  const openPro = (reason?: string): void => {
    if (!COMMERCIALIZATION_DRAFT_ENABLED) return
    setProReason(reason ?? null)
    setProRedeem(false)
    setProOpen(true)
    cue('bloom')
  }

  const openRedeem = (): void => {
    if (!COMMERCIALIZATION_DRAFT_ENABLED) return
    setProReason(null)
    setProRedeem(true)
    setProOpen(true)
    cue('bloom')
  }

  const finishOnboarding = (intent?: 'download'): void => {
    markOnboarded()
    setOnboarding(false)
    if (intent === 'download') openComposer()
  }

  useEffect(() => {
    return window.ndm?.onEvent((message) => {
      if (message.op === 'installProgress') {
        const path = typeof message.path === 'string' ? message.path : ''
        const phase = typeof message.phase === 'string' ? message.phase as InstallProgressPhase : null
        if (!path || !phase) return
        // Installation is the next stage of the flow; once it begins, the
        // completion ceremony yields visual priority to installation status.
        confettiRef.current?.clear()
        setCompletionNotice((current) => current?.fullPath === path ? null : current)
        setInstallProgress((current) => ({
          id: current?.path === path ? current.id : Date.now(),
          path,
          phase,
          appName: typeof message.appName === 'string' ? message.appName.replace(/\.app$/i, '') : undefined,
          detail: typeof message.detail === 'string' ? message.detail : undefined,
          appIcon: typeof message.appIcon === 'string'
            ? message.appIcon
            : current?.path === path
              ? current.appIcon
              : undefined,
          installedPath: typeof message.installedPath === 'string'
            ? message.installedPath
            : current?.path === path
              ? current.installedPath
              : undefined
        }))
        // The result owns actionable feedback until it is dismissed. A timer
        // must not hide a pending open/retry or its later failure message.
        return
      }

      if (message.op === 'openMediaComposer') {
        const url = typeof message.url === 'string' ? message.url : ''
        if (!url) return
        const browserSession = browserMediaSessionFromEvent(message)
        // An existing review owns new incoming links. Do not create a hidden
        // task underneath it or replace work awaiting a creation receipt.
        if (composingRef.current) {
          mediaPresentationEpoch.current++
          setComposerPrefill(url)
          setComposerBrowserSession(browserSession)
          return
        }
        const presentation = ++mediaPresentationEpoch.current
        const ownsPresentation = (): boolean => mediaPresentationEpoch.current === presentation
        // The Relay hands off every link, but a link the server answers with
        // a file is a download, not a compose session — start it directly and
        // keep the composer for pages that genuinely need a format choice.
        void (async () => {
          try {
            const classified = browserSession || isKnownMediaSiteURL(url) ? null : await window.ndm?.classifyURL?.(url)
            if (classified?.kind === 'binary') {
              const task = await addFromUrl(url)
              if (!ownsPresentation()) return
              setSelectedIds(new Set([task.id]))
              cue('success')
              return
            }
          } catch {
            // Classification or download failed — fall back to the composer
            // so the user still gets the manual path with its error hints.
          }
          if (!ownsPresentation()) return
          setComposerPrefill(url)
          setComposerBrowserSession(browserSession)
          setComposing(true)
          setSettings(false)
          setContextMenu(null)
          cue('bloom')
        })()
        return
      }

      if (message.op === 'downloadCompleted' && message.task && typeof message.task === 'object') {
        const task = message.task as Record<string, unknown>
        const id = Number(task.id)
        const filename = typeof task.filename === 'string' ? task.filename : ''
        if (!Number.isFinite(id) || !filename) return
        // The completion bar is the entry point; never reset the user's
        // filter, search or selection just because a task finished.
        const completedTask = getTasks().find(candidate => candidate.id === id)
        const byteCount = completedTask?.status === 'complete'
          ? completedTask.completedBytes > 0 ? completedTask.completedBytes : completedTask.fileSize > 0 ? completedTask.fileSize : undefined
          : undefined
        setCompletionNotice({
          id,
          byteCount,
          filename,
          title: typeof task.title === 'string' ? task.title : filename,
          folderPath: typeof task.folderPath === 'string' ? task.folderPath : '',
          fullPath: typeof task.fullPath === 'string' ? task.fullPath : filename
        })
        cue('success')
      }
    })
  }, [])

  // Stable IDs survive sorting, live snapshots and Hero/list transitions.
  const keyboardTasksRef = useRef(keyboardTasks)
  keyboardTasksRef.current = keyboardTasks

  const toggleCollection = useCallback((collectionID: string): void => {
    setExpandedCollections((current) => {
      const next = new Set(current)
      if (next.has(collectionID)) next.delete(collectionID)
      else next.add(collectionID)
      return next
    })
  }, [])

  const expandCollection = useCallback((collectionID: string): void => {
    setExpandedCollections((current) => {
      if (current.has(collectionID)) return current
      return new Set([...current, collectionID])
    })
  }, [])

  const handleSelectTask = useCallback((e: React.MouseEvent, task: Task, _index: number): void => {
    setDismissedInspector(null)
    cue('tick')
    selectionFocus.current = task.id
    if (e.shiftKey) {
      setSelectedIds(selectionRange(keyboardTasksRef.current.map((row) => row.id), selectionAnchor.current, task.id))
      if (selectionAnchor.current === null) selectionAnchor.current = task.id
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(task.id)) next.delete(task.id)
        else next.add(task.id)
        return next
      })
      selectionAnchor.current = task.id
    } else {
      setSelectedIds(new Set([task.id]))
      selectionAnchor.current = task.id
    }
  }, [])

  const handleRowContextMenu = useCallback((e: React.MouseEvent, task: Task): void => {
    setSelectedIds((prev) => (prev.has(task.id) ? prev : new Set([task.id])))
    selectionAnchor.current = task.id
    selectionFocus.current = task.id
    setContextMenu({ x: e.clientX, y: e.clientY, task })
  }, [])

  const requestDelete = useCallback((ids: number[], preferredDeleteFile = false): void => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) return
    const existing = ids.filter((id) => tasks.some((task) => task.id === id))
    if (existing.length === 0) return
    setContextMenu(null)
    setPendingDeleteError('')
    setPendingDelete({ ids: existing, preferredDeleteFile })
    cue('page')
  }, [tasks])

  const cancelPendingDelete = useCallback((): void => {
    if (deletingPendingTasks) return
    setPendingDeleteError('')
    setPendingDelete(null)
    cue('release')
  }, [deletingPendingTasks])

  const confirmPendingDelete = async (deleteFile: boolean): Promise<void> => {
    if (!pendingDelete || deletingPendingTasks) return
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) {
      setPendingDeleteError('另一个任务操作正在进行，请稍后重试。')
      return
    }
    libraryActionRef.current = true
    setLibraryAction('delete')
    setDeletingPendingTasks(true)
    setPendingDeleteError('')
    try {
      await removeMany(pendingDelete.ids, deleteFile)
      const removed = new Set(pendingDelete.ids)
      setSelectedIds((current) => new Set(Array.from(current).filter((id) => !removed.has(id))))
      setPendingDelete(null)
      cue('droplet')
    } catch (error) {
      setPendingDeleteError(error instanceof Error && error.message.startsWith('只删除了 ')
        ? error.message
        : '未能删除所选任务。请重试。')
    } finally {
      libraryActionRef.current = false
      setLibraryAction(null)
      setDeletingPendingTasks(false)
    }
  }

  useEffect(() => {
    const existing = new Set(visible.map((task) => task.id))
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => existing.has(id)))
      return next.size === current.size ? current : next
    })
  }, [visible])

  const runFileCommand = useCallback(async (task: Task, kind: 'open' | 'preview' | 'reveal' | 'share' | 'copy' | 'source'): Promise<void> => {
    const request = ++previewRequest.current
    setPreviewNotice(null)
    const notify = (message: string): void => { if (request === previewRequest.current) setPreviewNotice({ message }) }
    const current = getTasks().find(candidate => candidate.id === task.id)
    if (!current) { notify('这个任务已不在列表中'); return }
    const path = current.folderPath ? `${current.folderPath}/${current.filename}` : current.filename
    if (kind === 'preview' || kind === 'open' || kind === 'reveal' || kind === 'share') {
      const message = await runFileDeliveryAction(kind, () => kind === 'preview' ? quickLook(path) : kind === 'open' ? openFile(path) : kind === 'reveal' ? revealFile(path) : shareFile(path))
      if (message) notify(message)
      return
    }
    const failures = { open: '暂时无法打开文件，请重试', preview: '找不到文件，无法预览', reveal: `无法在${FILE_MANAGER}中显示文件`, share: '暂时无法分享文件，请重试', copy: '未能复制链接，请重试', source: '暂时无法打开来源网页' }
    try {
      let ok = true
      if (kind === 'source') ok = Boolean(current.pageURL) && await openExternal(current.pageURL!)
      else { await copyToClipboard(current.url); cue('tick') }
      if (!ok) notify(failures[kind])
    } catch { notify(failures[kind]) }
  }, [])

  // Keyboard navigation & shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process' || event.altKey) return
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      const typing = isEditableTarget(event.target)
      // Modal surfaces and menus own their keyboard interaction; never operate on downloads underneath.
      if (destinationTaskID !== null || onboarding || cleanupOpen || pendingDelete || shortcutsOpen || commandsOpen || savedViewsOpen || viewControlsOpen || contextMenu) return
      if (composing) return // Composer owns Escape and its durable close boundary.
      if (settings || (COMMERCIALIZATION_DRAFT_ENABLED && proOpen)) {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (settings) setSettings(false)
          else setProOpen(false)
        } else if (settings && (event.metaKey || event.ctrlKey) && event.key === ',') {
          event.preventDefault()
          setSettings(false)
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!event.repeat) { setCommandsOpen(true); cue('press') }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        const search = document.getElementById('ndm-search') as HTMLInputElement | null
        search?.focus()
        search?.select()
        return
      }

      // Preferences (Cmd+,)
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        setSettings((open) => !open)
        return
      }

      // New Download (Cmd+N)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        openComposer()
        return
      }

      if (typing) return

      // Native controls retain Enter, Space and arrow behavior. Only task-row buttons opt into list navigation.
      if (event.target instanceof Element &&
          event.target.closest('button, summary, a[href], [role="slider"], [role="separator"], [role="menu"]') &&
          !event.target.closest('[data-task-select]')) return

      // Shortcuts cheat sheet (? = Shift+/)
      if (event.key === '?') {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        cue('page')
        return
      }

      // Select All (Cmd+A)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelectedIds(new Set(keyboardTasks.map((t) => t.id)))
        return
      }

      // Copy URL (Cmd+C)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectedTask) {
        event.preventDefault()
        void runFileCommand(selectedTask, 'copy')
        return
      }

      // Reveal in Finder (Cmd+R)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r' && selectedTask) {
        event.preventDefault()
        void runFileCommand(selectedTask, 'reveal')
        return
      }

      // Quick Look (Space)
      if (event.key === ' ' && !event.metaKey && !event.ctrlKey && selectedTask) {
        event.preventDefault()
        const fp = selectedTask.folderPath
          ? `${selectedTask.folderPath}/${selectedTask.filename}`
          : selectedTask.filename
        if (event.repeat) return
        const request = ++previewRequest.current
        setPreviewNotice(null)
        const notify = (message: string) => {
          if (request === previewRequest.current) setPreviewNotice({ message })
        }
        void quickLook(fp).then((opened) => {
          if (!opened) notify(selectedTask.status === 'complete'
            ? '找不到文件，无法预览'
            : '下载完成后即可预览')
        }).catch(() => notify('暂时无法预览，请重试'))
        return
      }

      // Open / Toggle (Enter)
      if (event.key === 'Enter' && selectedTask) {
        event.preventDefault()
        const nextAction = taskNextAction(selectedTask)
        if (nextAction.disabled) return
        if (nextAction.kind === 'open') void runFileCommand(selectedTask, 'open')
        else if (nextAction.kind === 'inspect') setDismissedInspector(null)
        else void runTaskAction(selectedTask, nextAction.kind === 'restart' ? 'restart' : 'toggle')
        return
      }

      // Delete (Delete / Backspace / Cmd+Backspace)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.size > 0) {
        event.preventDefault()
        const deleteFile = event.metaKey || event.ctrlKey
        requestDelete(Array.from(selectedIds), deleteFile)
        return
      }

      // Navigate ArrowUp / ArrowDown
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = moveSelection(keyboardTasks.map((task) => task.id), selectionAnchor.current,
          selectionFocus.current, event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
        setSelectedIds(next.selected)
        selectionAnchor.current = next.anchorId
        selectionFocus.current = next.focusId
        return
      }

      if (event.key === 'Escape') {
        if (settings) {
          setSettings(false)
          return
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false)
          return
        }
        if (contextMenu) {
          setContextMenu(null)
          return
        }
        if (composing) {
          closeComposer()
          return
        }
        if (selectedIds.size > 0) {
          setSelectedIds(new Set())
          selectionAnchor.current = null
          selectionFocus.current = null
          return
        }
        return
      }

      if (event.key === '/') {
        event.preventDefault()
        document.getElementById('ndm-search')?.focus()
        return
      }
    }
    window.addEventListener('keydown', onKey)

    const offMenu = window.ndm?.onMenuAction?.((action) => {
      if (onboarding || cleanupOpen || pendingDelete || shortcutsOpen || commandsOpen || savedViewsOpen || viewControlsOpen || composing || settings || proOpen) return
      if (action === 'new-download') openComposer()
      else if (action === 'open-settings') setSettings(true)
      else if (action === 'focus-search') document.getElementById('ndm-search')?.focus()
      else if (action === 'open-commands') { setCommandsOpen(true); cue('press') }
    })

    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [settings, contextMenu, composing, selectedIds, selectedTask, keyboardTasks, onboarding, proOpen, cleanupOpen, shortcutsOpen, commandsOpen, savedViewsOpen, viewControlsOpen, pendingDelete, destinationTaskID, requestDelete, runTaskAction, runFileCommand])

  const [isDragging, setIsDragging] = useState(false)
  const [dropTargetHot, setDropTargetHot] = useState(false)
  const dropDialogRef = useRef<HTMLDivElement | null>(null)
  const dropTargetHotRef = useRef(false)
  const [dropIssue, setDropIssue] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const dropIssueTimer = useRef<number | null>(null)
  const [confirmResumeAll, setConfirmResumeAll] = useState(false)
  const confirmResumeTimer = useRef<number | null>(null)
  const [libraryAction, setLibraryAction] = useState<'pause' | 'resume' | 'retry' | 'collection' | 'delete' | null>(null)
  const libraryActionBusy = libraryAction !== null

  const activeCount = tasks.filter((t) => t.status === 'downloading').length
  const recordingCount = tasks.filter((task) => task.status === 'downloading' && task.isLiveRecording).length
  const pausedIds = visible.filter(t => t.status === 'paused' || t.status === 'incomplete').map(t => t.id)
  const pausedCount = pausedIds.length
  const failedIds = useMemo(
    () => visible.filter((t) => t.status === 'error').map((t) => t.id),
    [visible]
  )

  const runLibraryAction = async (action: 'pause' | 'resume'): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) return
    libraryActionRef.current = true
    setLibraryAction(action)
    setLibraryActionError('')
    setTaskActionError('')
    try {
      if (action === 'pause') await pauseAll()
      else {
        let succeeded = 0
        for (const id of pausedIds) {
          try { await setTaskPaused(id, false); succeeded += 1 } catch { /* Keep the remaining matching tasks eligible. */ }
        }
        if (succeeded !== pausedIds.length) {
          setLibraryActionError(succeeded ? `已继续 ${succeeded}/${pausedIds.length} 项，请重试剩余任务。` : '未能继续已暂停任务。请重试。')
          cue('droplet')
          return
        }
      }
      cue('success')
    } catch {
      setLibraryActionError(
        action === 'pause'
          ? '未能暂停全部任务。请重试。'
          : '未能继续已暂停任务。请重试。'
      )
      cue('droplet')
    } finally {
      libraryActionRef.current = false
      setLibraryAction(null)
    }
  }

  const runCollectionAction = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) {
      throw new Error('另一个任务操作正在进行，请稍后重试。')
    }
    libraryActionRef.current = true
    setLibraryAction('collection')
    try {
      await operation()
    } finally {
      libraryActionRef.current = false
      setLibraryAction(null)
    }
  }, [])

  const retryEngineNow = useCallback((): void => {
    void retryEngine()
  }, [])

  const engineBannerError =
    engineStatus !== 'live' && engineError && engineError !== dismissedEngineError ? engineError : null

  // A live link ends the outage outright: the next outage re-opens the banner
  // even when the main process reports the same failure reason again.
  useEffect(() => {
    if (engineStatus === 'live') setDismissedEngineError(null)
  }, [engineStatus])

  // Resuming a large historical library is destructive-adjacent: thousands of
  // stale tasks would start at once. Ask for a second click when it's big.
  useEffect(() => {
    setConfirmResumeAll(false)
    if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
  }, [criteria])

  const handleResumeAll = (): void => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) return
    if (pausedCount > 20 && !confirmResumeAll) {
      setConfirmResumeAll(true)
      if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
      confirmResumeTimer.current = window.setTimeout(() => setConfirmResumeAll(false), 4000)
      return
    }
    if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
    setConfirmResumeAll(false)
    void runLibraryAction('resume')
  }

  const retryAllFailed = async (): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current || failedIds.length === 0) return
    libraryActionRef.current = true
    setLibraryAction('retry')
    setLibraryActionError('')
    setTaskActionError('')
    try {
      const count = await restartMany(failedIds)
      if (count !== failedIds.length) {
        setLibraryActionError(`只重试了 ${count}/${failedIds.length} 个失败任务。请检查剩余任务后重试。`)
        cue('droplet')
        return
      }
      cue('success')
    } catch {
      setLibraryActionError('未能重试失败任务。请重试。')
      cue('droplet')
    } finally {
      libraryActionRef.current = false
      setLibraryAction(null)
    }
  }
  const totalBytesPerSec = tasks
    .filter((t) => t.status === 'downloading')
    .reduce((sum, t) => sum + (t.bytesPerSecond || 0), 0)

  const showDropIssue = (message: string): void => {
    setDropIssue(message)
    if (dropIssueTimer.current) window.clearTimeout(dropIssueTimer.current)
    dropIssueTimer.current = window.setTimeout(() => {
      setDropIssue(null)
      dropIssueTimer.current = null
    }, 3500)
  }

  const clearDropIssue = (): void => {
    setDropIssue(null)
    if (dropIssueTimer.current) {
      window.clearTimeout(dropIssueTimer.current)
      dropIssueTimer.current = null
    }
  }

  useEffect(
    () => () => {
      if (dropIssueTimer.current) window.clearTimeout(dropIssueTimer.current)
      if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
    },
    []
  )

  const handleDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    // Native drags from our own rows return through these handlers as Files.
    // Only incoming links need a receiver; file drags leave the workspace alone.
    if (!dragCarriesDownloadLink(Array.from(e.dataTransfer.types))) {
      resetDropTarget()
      return
    }
    dragDepth.current += 1
    clearDropIssue()
    setIsDragging(true)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const accepted = dragCarriesDownloadLink(Array.from(e.dataTransfer.types))
    e.dataTransfer.dropEffect = accepted ? 'copy' : 'none'
    if (!accepted) {
      resetDropTarget()
      return
    }
    // The veil is pointer-events-none, so hover is derived from the drag
    // position relative to the dialog rect instead of CSS :hover.
    const rect = dropDialogRef.current?.getBoundingClientRect()
    const hot = accepted && !!rect
      && e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom
    if (dropTargetHotRef.current !== hot) {
      dropTargetHotRef.current = hot
      setDropTargetHot(hot)
    }
  }

  const clearDropHot = (): void => {
    dropTargetHotRef.current = false
    setDropTargetHot(false)
  }

  const resetDropTarget = (): void => {
    dragDepth.current = 0
    setIsDragging(false)
    clearDropHot()
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) {
      setIsDragging(false)
      clearDropHot()
    }
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    resetDropTarget()

    const resolution = resolveDroppedInput({
      uriList: e.dataTransfer.getData('text/uri-list'),
      plainText: e.dataTransfer.getData('text/plain'),
      hasFiles: e.dataTransfer.files.length > 0
    })
    if (resolution.accepted) {
      openComposer(resolution.link.urlString)
      return
    }
    if (resolution.reason === 'localFile') return
    showDropIssue('没有识别到可下载的链接，请拖入网页链接、文件直链或磁力链')
  }

  // Batch actions
  const [batchTaskAction, setBatchTaskAction] = useState<'resume' | 'pause' | null>(null)
  const [batchTaskError, setBatchTaskError] = useState('')
  const batchTaskBusy = batchTaskAction !== null
  const taskMutationBusy = Boolean(taskAction) || libraryActionBusy || batchTaskBusy
  const selectedTasks = tasks.filter((task) => selectedIds.has(task.id))
  const selectedPauseCount = selectedTasks.filter((task) => task.status === 'downloading' || task.status === 'waiting').length
  const selectedResumeCount = selectedTasks.filter((task) => task.status !== 'downloading' && task.status !== 'waiting' && task.status !== 'complete').length

  // Snapshots may remove successful rows from the active filter. Keep the
  // batch result until dismissal or the next attempt, independently of selection.

  const runBatchTaskAction = async (action: 'resume' | 'pause'): Promise<void> => {
    if (taskActionBusyRef.current || libraryActionRef.current || batchTaskBusyRef.current) return
    const selection = Array.from(selectedIds)
    if (selection.length === 0) return

    batchTaskBusyRef.current = true
    setBatchTaskAction(action)
    setBatchTaskError('')
    const verb = action === 'resume' ? '继续' : '暂停'
    try {
      const targets = await getTaskPauseTargets(selection, action === 'pause')
      const confirmed = new Map(targets.map(task => [task.id, task]))
      const ids = targets.map(task => task.id)
      if (!ids.length) return
      let acknowledged = 0
      for (const id of ids) {
        try {
          await setTaskPaused(id, action === 'pause', confirmed.get(id))
          acknowledged += 1
        } catch {
          // Keep processing: one stale or failed row must not hide the batch result.
        }
      }
      if (acknowledged === ids.length) {
        cue('success')
      } else {
        setBatchTaskError(
          acknowledged === 0
            ? `未能${verb}所选任务。请重试。`
            : `只${verb}了 ${acknowledged}/${ids.length} 个任务。请检查剩余任务后重试。`
        )
        cue('droplet')
      }
    } catch {
      setBatchTaskError(`未能${verb}所选任务。请重试。`)
      cue('droplet')
    } finally {
      batchTaskBusyRef.current = false
      setBatchTaskAction(null)
    }
  }

  const handleBatchCopy = (): void => {
    const urls = tasks.filter((t) => selectedIds.has(t.id)).map((t) => t.url).join('\n')
    if (urls) {
      void copyToClipboard(urls).then(() => cue('tick')).catch(() => setPreviewNotice({ message: '未能复制链接，请重试' }))
    }
  }

  const handleBatchDelete = (deleteFile: boolean): void => {
    requestDelete(Array.from(selectedIds), deleteFile)
  }

  const commandItems: CommandPaletteItem[] = [
    { id: 'new-download', label: '添加下载', detail: '粘贴一个链接，或准备一批下载', keywords: ['new', 'download', 'add', '新建', '批量'], shortcut: `${COMMAND_KEY} N`, onSelect: () => openComposer() },
    { id: 'search', label: '搜索下载任务', keywords: ['find', 'search', '查找', '文件', '网站'], shortcut: `${COMMAND_KEY} F`, onSelect: () => { const search = document.getElementById('ndm-search') as HTMLInputElement | null; search?.focus(); search?.select() } },
    { id: 'saved-views', label: '常用视图', detail: '保存常用筛选，随时返回', keywords: ['saved', 'view', 'filter', '筛选', '常用'], onSelect: () => { savedViews.clearError(); setSavedViewsOpen(true) } },
    { id: 'settings', label: '设置', detail: '外观、声音、下载与浏览器连接', keywords: ['settings', 'preferences', '主题', '网络'], shortcut: `${COMMAND_KEY} ,`, onSelect: () => setSettings(true) },
    { id: 'shortcuts', label: '键盘快捷键', keywords: ['keyboard', 'shortcuts', '帮助'], shortcut: '?', onSelect: () => setShortcutsOpen(true) },
    { id: 'welcome', label: '重看使用引导', keywords: ['welcome', 'onboarding', '入门', '演示'], onSelect: () => setOnboarding(true) }
  ]
  if (selectedTask) {
    const task = selectedTask
    const done = task.status === 'complete'
    const working = task.status === 'downloading' || task.status === 'waiting'
    const nextAction = taskNextAction(task)
    const mainLabel = nextAction.ariaLabel
    commandItems.unshift(
      { id: 'task-primary', scope: 'selection', label: mainLabel, keywords: done ? ['open', '打开'] : working ? ['pause', 'stop', '暂停', '停止'] : task.status === 'error' ? ['retry', '重试'] : ['resume', '继续'], shortcut: 'Enter', disabled: (!done && taskMutationBusy) || nextAction.disabled, onSelect: () => { if (nextAction.kind === 'open') void runFileCommand(task, 'open'); else if (nextAction.kind === 'inspect') setDismissedInspector(null); else void runTaskAction(task, nextAction.kind === 'restart' ? 'restart' : 'toggle') } },
      ...(done ? [{ id: 'task-restart', scope: 'selection' as const, label: '重新下载', keywords: ['retry', 'restart', '重试'], disabled: taskMutationBusy, onSelect: () => void runTaskAction(task, 'restart') }] : []),
      { id: 'task-preview', scope: 'selection', label: '快速预览', detail: done ? undefined : '下载完成后可用', keywords: ['preview', 'quicklook', '空格'], shortcut: 'Space', disabled: !done, onSelect: () => void runFileCommand(task, 'preview') },
      { id: 'task-reveal', scope: 'selection', label: `在${FILE_MANAGER}中显示`, keywords: ['finder', 'reveal', 'explorer', '保存位置'], shortcut: `${COMMAND_KEY} R`, disabled: !done, onSelect: () => void runFileCommand(task, 'reveal') },
      { id: 'task-copy', scope: 'selection', label: '复制下载链接', keywords: ['copy', 'url', '网址'], shortcut: `${COMMAND_KEY} C`, onSelect: () => void runFileCommand(task, 'copy') },
      { id: 'task-share', scope: 'selection', label: '分享文件', keywords: ['share', '发送'], disabled: !done, onSelect: () => void runFileCommand(task, 'share') },
      ...(task.pageURL ? [{ id: 'task-source', scope: 'selection' as const, label: '打开来源网页', keywords: ['source', 'website', '网站'], onSelect: () => void runFileCommand(task, 'source') }] : []),
      { id: 'task-delete', scope: 'selection', label: '删除任务…', detail: '下一步选择是否同时删除文件', keywords: ['delete', 'remove', '移除'], shortcut: 'Delete', disabled: taskMutationBusy, onSelect: () => requestDelete([task.id]) }
    )
  } else if (selectedTasks.length > 1) {
    commandItems.unshift(
      { id: 'selection-copy', scope: 'selection', label: '复制所选下载链接', keywords: ['copy', 'links', '批量'], onSelect: handleBatchCopy },
      { id: 'selection-delete', scope: 'selection', label: '删除所选任务…', detail: '下一步选择是否同时删除文件', keywords: ['delete', 'remove', '批量'], disabled: taskMutationBusy, onSelect: () => requestDelete(selectedTasks.map(task => task.id)) }
    )
  }

  return (
    <div
      data-sidebar-mode={sidebarMode}
      data-composing={composing || undefined}
      className="ndm-workspace relative flex h-full min-w-0 overflow-hidden bg-ink text-paper select-none"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragEnd={resetDropTarget}
      onDrop={handleDrop}
    >
      {/* Drag & drop needs a clear target, not a decorative takeover. */}
      {isDragging ? (
        <motion.div
          key="drop-veil"
          data-download-drop-target
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink/92"
        >
          {/* Deliberately plain veil: the dialog answers the cursor, no frame or wash. */}
          <div
            ref={dropDialogRef}
            className={`relative flex w-[min(460px,calc(100%-48px))] items-start gap-4 rounded-xl border bg-raised px-6 py-5 shadow-dialog transition-[border-color,scale] duration-150 ease-out motion-reduce:scale-100 ${dropTargetHot ? 'scale-[1.03] border-copper/70' : 'border-line-strong'}`}
          >
            <ArrowDown size={22} strokeWidth={1.8} className={`mt-0.5 shrink-0 transition-colors duration-150 ${dropTargetHot ? 'text-copper' : 'text-fog'}`} />
            <div className="min-w-0">
              <div className="text-[18px] font-semibold leading-tight text-paper">
                释放以检查下载
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-mist">
                支持网页、文件直链、媒体链接和磁力链；确认后再开始
              </p>
            </div>
          </div>
        </motion.div>
      ) : null}

      {dropIssue ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-[12px] text-fog shadow-popover"
        >
          {dropIssue}
        </div>
      ) : null}

      <Sidebar
        activeFilters={criteria.status === 'all' && criteria.type === 'all' ? ['all'] : [criteria.status, criteria.type].filter(id => id !== 'all') as FilterId[]}
        onSavedViews={() => { savedViews.clearError(); setSavedViewsOpen(true) }}
        savedViewName={activeSavedView?.name}
        onClose={() => setSidebarMode('closed')}
        filter={filter}
        engineStatus={engineStatus}
        engineError={engineError}
        onFilter={(f) => {
          if (window.innerWidth <= 760) setSidebarMode('closed')
          setFilter(f)
          setSelectedIds(new Set())
          selectionAnchor.current = null
          selectionFocus.current = null
        }}
        onNew={() => openComposer()}
        onSettings={() => setSettings(true)}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main id="main-content" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <LibraryToolbar
          transferControl={<TransferControl temporaryLabel={temporaryBandwidthLabel(temporaryBandwidth.snapshot)} activeCount={activeCount} liveCount={recordingCount}
            waitingCount={tasks.filter(task => task.status === 'waiting').length} bytesPerSecond={totalBytesPerSec}
            busy={taskMutationBusy} error={libraryActionError || undefined}
            onPauseAll={() => void runLibraryAction('pause')}
            onShowActive={() => changeCriteria({ ...DEFAULT_VIEW_CRITERIA, status: activeCount ? 'active' : 'queued' })}>
              {!IS_WINDOWS ? <TemporaryBandwidth snapshot={temporaryBandwidth.snapshot} busy={temporaryBandwidth.busy} error={temporaryBandwidth.error}
                onApply={temporaryBandwidth.apply} onRestore={temporaryBandwidth.restore} /> : null}
            </TransferControl>}
          title={activeSavedView?.name}
          headingControls={<LibraryViewSummary criteria={criteria} onChange={changeCriteria} activeViewName={activeSavedView?.name} />}
          viewControls={<LibraryViewControls sort={taskSort} onSort={setTaskSort} criteria={criteria} onChange={changeCriteria} activeViewName={activeSavedView?.name}
            onOpenChange={setViewControlsOpen}
            onSave={name => { const result = savedViews.save(name, criteria, taskSort); if (result.ok) setActiveSavedViewID(result.id); return result }} />}
          contextualToolbar={selectedIds.size > 1 || batchTaskBusy ? <SelectionActions
            tasks={selectedTasks} busy={taskMutationBusy} action={batchTaskAction} describedBy={batchTaskError ? 'batch-task-action-status' : undefined}
            resumeCount={selectedResumeCount} pauseCount={selectedPauseCount}
            onResume={() => void runBatchTaskAction('resume')} onPause={() => void runBatchTaskAction('pause')}
            onCopy={handleBatchCopy} onDelete={() => handleBatchDelete(false)}
            onClear={() => { setSelectedIds(new Set()); setBatchTaskError('') }} /> : undefined}
          onToggleSidebar={() => setSidebarMode(document.getElementById('main-sidebar')?.getBoundingClientRect().width ? 'closed' : 'open')}
          inspectorAvailable={Boolean(selectedTask)}
          inspectorOpen={Boolean(selectedTask && dismissedInspector !== selectedTask.id)}
          onToggleInspector={() => setDismissedInspector(selectedTask && dismissedInspector !== selectedTask.id ? selectedTask.id : null)}
          filter={filter} count={visible.length} query={query} onQuery={changeQuery}>
          <div className="app-no-drag flex items-center gap-2 text-[13px]">
            {pausedCount > 0 && criteria.status === 'paused' ? <button type="button" disabled={taskMutationBusy}
              aria-describedby={libraryActionError ? 'library-action-status' : undefined} onClick={handleResumeAll}
              className={`ndm-toolbar-action h-control whitespace-nowrap rounded-control border px-2.5 ${confirmResumeAll ? 'border-copper/60 text-copper' : 'border-line text-fog'} disabled:opacity-50`}>
              {libraryAction === 'resume' ? '继续中…' : confirmResumeAll ? `确认继续 ${pausedCount} 项` : `继续这 ${pausedCount} 项`}
            </button> : null}
            {failedIds.length > 0 && criteria.status === 'failed' ? <button type="button" disabled={taskMutationBusy}
              aria-describedby={libraryActionError ? 'library-action-status' : undefined} onClick={() => void retryAllFailed()}
              className="ndm-toolbar-action h-control whitespace-nowrap rounded-control border border-line px-2.5 text-fog disabled:opacity-50">
              {libraryAction === 'retry' ? '重试中…' : `重试这 ${failedIds.length} 项`}
            </button> : null}
          </div>
        </LibraryToolbar>

        {/* Status bands stay quiet: the hue lives in the mark and the recovery
            action, never in a red wash across the whole row. */}
        {engineBannerError ? (
          <div
            id="engine-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-line bg-raised/60 px-6 py-1.5 text-meta text-fog"
          >
            <span className="flex min-w-0 items-center gap-2">
              <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-clay" />
              <span className="min-w-0 truncate" title={engineBannerError}>
                {engineStatus === 'connecting' ? '下载引擎连接中' : '下载引擎不可用'}：{engineBannerError}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                data-cuelume-press="tick"
                onClick={retryEngineNow}
                className="h-control rounded-control border border-line px-2.5 text-label text-fog transition-colors hover:bg-line hover:text-paper"
              >
                重试连接
              </button>
              <button
                type="button"
                aria-label="关闭引擎状态提示"
                onClick={() => setDismissedEngineError(engineBannerError)}
                className="grid size-control place-items-center rounded-control text-mist transition-colors hover:bg-line hover:text-paper"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ) : null}

        {libraryActionError ? (
          <div
            id="library-action-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-line bg-raised/60 px-6 py-1.5 text-meta text-fog"
          >
            <span className="flex min-w-0 items-center gap-2">
              <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-clay" />
              <span className="min-w-0 truncate" title={libraryActionError}>{libraryActionError}</span>
            </span>
            <button
              type="button"
              aria-label="关闭批量操作提示"
              onClick={() => setLibraryActionError('')}
              className="grid size-control shrink-0 place-items-center rounded-control text-mist transition-colors hover:bg-line hover:text-paper"
            >
              <X size={13} />
            </button>
          </div>
        ) : null}

        {taskActionError ? (
          <div
            id="task-action-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-line bg-raised/60 px-6 py-1.5 text-meta text-fog"
          >
            <span className="flex min-w-0 items-center gap-2">
              <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-clay" />
              <span className="min-w-0 truncate" title={taskActionError}>{taskActionError}</span>
            </span>
            <button
              type="button"
              aria-label="关闭任务操作提示"
              onClick={() => setTaskActionError('')}
              className="grid size-control shrink-0 place-items-center rounded-control text-mist transition-colors hover:bg-line hover:text-paper"
            >
              <X size={13} />
            </button>
          </div>
        ) : null}

        {batchTaskError ? <div id="batch-task-action-status" role="status" aria-live="polite" className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-raised/60 px-6 py-2 text-[13px] text-clay">
          <span>{batchTaskError}</span><button type="button" aria-label="关闭批量任务提示" onClick={() => setBatchTaskError('')} className="rounded p-1 text-mist hover:text-paper"><X size={14} /></button>
        </div> : null}

        {/* Hero Active Card (for single active download when on all/active filter) */}
        {hero ? (
          <Hero
            task={hero}
            actionBusy={taskMutationBusy}
            actionErrorId={taskActionError ? 'task-action-status' : undefined}
            position={heroPosition >= 0 ? heroPosition + 1 : 1}
            total={heroCycleCandidates.length}
            onToggle={(task) => void runTaskAction(task, 'toggle')}
            onNext={heroCycleCandidates.length > 1 ? () => {
              const nextIndex = (Math.max(0, heroPosition) + 1) % heroCycleCandidates.length
              const nextTask = heroCycleCandidates[nextIndex]
              setSpotlightTaskID(nextTask.id)
              setSelectedIds((current) =>
                current.size === 1 && current.has(hero.id) ? new Set([nextTask.id]) : current
              )
            } : undefined}
            onInspect={(task) => {
              setSelectedIds(new Set([task.id]))
              selectionAnchor.current = task.id
              selectionFocus.current = task.id
            }}
          />
        ) : null}

        {/* Task List */}
        <VirtualTaskList
          viewKey={JSON.stringify(criteria)}
          onFileCommand={runFileCommand}
          transferView={filter === 'active'}
          tasks={rest}
          allTasks={tasks}
          selectedIds={selectedIds}
          celebratingIds={celebratingIds}
          expandedCollections={displayedCollections}
          empty={!hero ? <EmptyState loading={!libraryReady} filter={filter} query={query} constrained={criteria.time !== 'any' || (criteria.status !== 'all' && criteria.type !== 'all')} onNew={() => openComposer()} onClearSearch={() => { changeQuery(''); document.getElementById('ndm-search')?.focus() }} onShowAll={() => changeCriteria({ ...DEFAULT_VIEW_CRITERIA, query })} /> : null}
          onSelect={handleSelectTask}
          onContextMenu={handleRowContextMenu}
          onToggleCollection={toggleCollection}
          onExpandCollection={expandCollection}
          actionBusyTaskID={taskAction?.taskID}
          actionBusyLabel={taskAction?.kind === 'schedule' ? '更新预约' : taskAction?.kind === 'delete' ? '删除中' : undefined}
          actionBlocked={taskMutationBusy}
          onCollectionAction={runCollectionAction}
          actionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
          installProgress={installProgress}
          sort={taskSort}
          onSort={handleTaskSort}
        />

        <TransferActivity
          notice={quietCompletion ? null : completionNotice}
          progress={installProgress}
          onDismissNotice={() => setCompletionNotice(null)}
          onDismissProgress={() => setInstallProgress(null)}
          onOpen={async (notice) => {
            confettiRef.current?.clear()
            return /\.dmg$/i.test(notice.fullPath) && window.ndm?.platform === 'darwin'
              ? await installDiskImage(notice.fullPath) : await openFile(notice.fullPath)
          }}
          onReveal={(notice) => {
            void revealFile(notice.fullPath)
          }}
          onRetryInstall={async (progress) => await installDiskImage(progress.path)}
        />

        {/* Composer Modal */}
        <Composer
          open={composing}
          initialUrl={composerPrefill}
          initialBrowserSession={composerBrowserSession}
          onClose={closeComposer}
          onCreated={(id, count = 1) => {
            setFilter('all')
            setQuery('')
            selectionAnchor.current = count > 1 ? null : id
            selectionFocus.current = count > 1 ? null : id
            setSelectedIds(count > 1 ? new Set() : new Set([id]))
            cue('success')
          }}
          onShowExisting={(id) => {
            setFilter('all')
            setQuery('')
            setSelectedIds(new Set([id]))
          }}
          onUpgrade={openPro}
          onClipboardConsumed={clipboard.consumeGeneration}
        />

        {clipboard.clipboardUrl && !composing ? (
          <ClipboardToast
            url={clipboard.clipboardUrl}
            onDownload={(url) => {
              void clipboard.consumeGeneration()
              openComposer(url)
            }}
            onDismiss={clipboard.dismissOffer}
          />
        ) : null}
        {previewNotice ? (
          <div
            role="status"
            data-preview-notice
            className="pointer-events-none absolute inset-x-4 bottom-5 z-30 flex justify-center"
          >
            <span className="rounded-lg border border-line bg-raised px-3 py-2 text-[12px] text-mist shadow-lg">
              {previewNotice.message}
            </span>
          </div>
        ) : null}
      </main>

      {selectedTask && selectedIds.size === 1 && dismissedInspector !== selectedTask.id ? (
        <Inspector
          task={selectedTask}
          installProgress={installProgress}
          taskActionBusy={taskMutationBusy}
          taskActionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
          onTaskMutation={runInspectorAction}
          onClose={() => setDismissedInspector(selectedTask.id)}
          onUpgrade={openPro}
        />
      ) : null}
      </div>

      {destinationTask ? <DestinationDialog key={destinationTask.id} task={destinationTask} onClose={closeDestination} /> : null}
      {pendingDelete ? (
        <DeleteTasksDialog
          count={pendingDelete.ids.length}
          preferredDeleteFile={pendingDelete.preferredDeleteFile}
          busy={deletingPendingTasks}
          error={pendingDeleteError}
          onConfirm={(deleteFile) => void confirmPendingDelete(deleteFile)}
          onCancel={cancelPendingDelete}
        />
      ) : null}

      {/* Settings Modal */}
      {!embed ? (
        <Settings
          open={settings}
          temporaryBandwidth={IS_WINDOWS ? undefined : temporaryBandwidth.snapshot}
          themeId={themeId}
          onTheme={onTheme}
          onClose={() => setSettings(false)}
          onClearHistory={() => {
            setSettings(false)
            setCleanupOpen(true)
          }}
          onUpgrade={() => {
            setSettings(false)
            openPro()
          }}
          onRedeem={() => {
            setSettings(false)
            openRedeem()
          }}
          onReonboard={() => {
            setSettings(false)
            resetOnboarding()
            setOnboarding(true)
            cue('page')
          }}
        />
      ) : null}

      {/* Optional history maintenance, reached from download settings. */}
      <CleanupModal
        open={cleanupOpen}
        onClose={() => {
          setCleanupOpen(false)
          setSettings(true)
        }}
      />

      {/* Keyboard shortcuts cheat sheet — press ? anywhere */}
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SavedViewsDialog open={savedViewsOpen} onClose={() => setSavedViewsOpen(false)} views={savedViews.views}
        onApply={applySavedView} onRename={savedViews.rename} onRemove={savedViews.remove} activeId={activeSavedView?.id} error={savedViews.error} />
      <CommandPalette open={commandsOpen} onClose={() => setCommandsOpen(false)} items={commandItems}
        selectionLabel={selectedTask?.filename || (selectedTasks.length > 1 ? `${selectedTasks.length} 个文件` : undefined)} />

      {/* Preserved for later real entitlement work; never exposed in Beta. */}
      {COMMERCIALIZATION_DRAFT_ENABLED ? (
        <ProModal open={proOpen} reason={proReason} startInRedeem={proRedeem} onClose={() => setProOpen(false)} />
      ) : null}

      {/* First-run onboarding — never over the gallery or the embed view */}
      {!embed ? <Onboarding open={onboarding} onFinish={finishOnboarding} themeId={themeId} onTheme={onTheme} /> : null}

      {/* Completion celebration canvas — mounted once, fired on task completion */}
      <Confetti
        ref={confettiRef}
        manualstart
        fullscreen
        data-testid="completion-confetti"
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[80] h-[100dvh] w-[100dvw]"
        globalOptions={{ useWorker: false, resize: true }}
      />

      {/* Right-click Context Menu */}
      {contextMenu ? (
        <ContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onToggle={(t) => void runTaskAction(t, 'toggle')}
          onRestart={(t) => void runTaskAction(t, 'restart')}
          onQuickLook={(t) => {
            const fp = t.folderPath ? `${t.folderPath}/${t.filename}` : t.filename
            void quickLook(fp)
          }}
          onReveal={(t) => {
            const fp = t.folderPath ? `${t.folderPath}/${t.filename}` : t.filename
            void revealFile(fp)
          }}
          onOpen={(t) => {
            const fp = t.folderPath ? `${t.folderPath}/${t.filename}` : t.filename
            void openFile(fp)
          }}
          onCopyUrl={(t) => {
            void copyToClipboard(t.url)
            cue('tick')
          }}
          onDelete={(t, deleteFile) => {
            requestDelete([t.id], deleteFile)
          }}
        />
      ) : null}
    </div>
  )
}
