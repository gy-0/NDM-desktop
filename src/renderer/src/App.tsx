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
import { isEditableTarget, moveSelection, selectionRange, workspaceHero } from './lib/workspace'
import { Gallery } from './Gallery'
import { formatSpeed } from './lib/format'
import { dragCarriesDownloadLink, resolveDroppedInput } from './lib/dropInput'
import { cue } from './lib/sound'
import {
  getTasks,
  copyToClipboard,
  filterTasks,
  addFromUrl,
  installDiskImage,
  openFile,
  openExternal,
  pauseAll,
  quickLook,
  removeMany,
  restartMany,
  restartTask,
  resumeAll,
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
import { COMMAND_KEY, FILE_MANAGER } from './lib/platform'
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
  const libraryReady = useLibraryReady()
  const engineStatus = useEngineStatus()
  const engineError = useEngineError()
  const [filter, setFilter] = useState<FilterId>('all')
  const [query, setQuery] = useState('')
  const [taskSort, setTaskSort] = useState<TaskSort>(readTaskSort)
  const [spotlightTaskID, setSpotlightTaskID] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [sidebarMode, setSidebarMode] = useState<'auto' | 'open' | 'closed'>('auto')
  const [dismissedInspector, setDismissedInspector] = useState<number | null>(null)
  const selectionAnchor = useRef<number | null>(null)
  const selectionFocus = useRef<number | null>(null)
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
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
  const [taskAction, setTaskAction] = useState<{ taskID: number; kind: 'toggle' | 'restart' } | null>(null)
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
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null)
  const installProgressTimer = useRef<number | null>(null)
  const [celebratingIds, setCelebratingIds] = useState<Set<number>>(new Set())
  const knownStatuses = useRef<Map<number, Task['status']>>(new Map())
  const celebrationTimers = useRef<Map<number, number>>(new Map())
  const confettiRef = useRef<ConfettiRef | null>(null)
  const clipboard = useClipboardOffer(tasks, composing, !onboarding)

  const [destinationTaskID, setDestinationTaskID] = useState<number | null>(null)
  const promptedDestinations = useRef(new Set<number>())
  const destinationTask = tasks.find(task => task.id === destinationTaskID && task.awaitingDestination)
  useEffect(() => {
    if (destinationTaskID !== null) {
      if (!destinationTask) setDestinationTaskID(null)
      return
    }
    if (composing || settings || onboarding || pendingDelete || cleanupOpen || proOpen || shortcutsOpen || commandsOpen || contextMenu) return
    const next = tasks.find(task => task.awaitingDestination && !promptedDestinations.current.has(task.id))
    if (next) { promptedDestinations.current.add(next.id); setDestinationTaskID(next.id) }
  }, [tasks, destinationTaskID, destinationTask, composing, settings, onboarding, pendingDelete, cleanupOpen, proOpen, shortcutsOpen, commandsOpen, contextMenu])
  const closeDestination = (id: number): void => setDestinationTaskID(current => current === id ? null : current)

  const runTaskAction = useCallback(async (task: Task, kind: 'toggle' | 'restart'): Promise<void> => {
    const current = getTasks().find(candidate => candidate.id === task.id)
    if (!current) return
    task = current
    if (task.awaitingDestination) { promptedDestinations.current.add(task.id); setDestinationTaskID(task.id); return }
    if (taskActionBusyRef.current) return
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
      const verb = kind === 'restart' ? '重试' : task.status === 'downloading' ? task.isLiveRecording ? '停止并保存' : '暂停' : '继续'
      setTaskActionError(`未能${verb}“${task.filename || task.title}”。请重试。`)
      cue('droplet')
    } finally {
      taskActionBusyRef.current = false
      setTaskAction(null)
    }
  }, [])

  const visible = useMemo(() => filterTasks(filter, query), [filter, query, tasks])
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
    confettiRef.current?.fire({
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
  }, [tasks])

  useEffect(
    () => () => {
      for (const timer of celebrationTimers.current.values()) window.clearTimeout(timer)
      if (installProgressTimer.current !== null) window.clearTimeout(installProgressTimer.current)
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
        if (installProgressTimer.current !== null) {
          window.clearTimeout(installProgressTimer.current)
          installProgressTimer.current = null
        }
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
        if (phase === 'complete' || phase === 'failed' || phase === 'cancelled') {
          installProgressTimer.current = window.setTimeout(() => {
            setInstallProgress((current) => (current?.path === path && current.phase === phase ? null : current))
            installProgressTimer.current = null
          }, phase === 'failed' || phase === 'complete' ? 8000 : 4200)
        }
        return
      }

      if (message.op === 'openMediaComposer') {
        const url = typeof message.url === 'string' ? message.url : ''
        if (!url) return
        const presentation = ++mediaPresentationEpoch.current
        const ownsPresentation = (): boolean => mediaPresentationEpoch.current === presentation
        // The Relay hands off every link, but a link the server answers with
        // a file is a download, not a compose session — start it directly and
        // keep the composer for pages that genuinely need a format choice.
        void (async () => {
          try {
            const classified = await window.ndm?.classifyURL?.(url)
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
        setCompletionNotice({
          id,
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

  // Keyboard navigation & shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process' || event.altKey) return
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      const typing = isEditableTarget(event.target)
      // Modal surfaces and menus own their keyboard interaction; never operate on downloads underneath.
      if (destinationTaskID !== null || onboarding || cleanupOpen || pendingDelete || shortcutsOpen || commandsOpen || contextMenu) return
      if (composing || settings || (COMMERCIALIZATION_DRAFT_ENABLED && proOpen)) {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (composing) closeComposer()
          else if (settings) setSettings(false)
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
        void copyToClipboard(selectedTask.url)
        cue('tick')
        return
      }

      // Reveal in Finder (Cmd+R)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r' && selectedTask) {
        event.preventDefault()
        const fp = selectedTask.folderPath
          ? `${selectedTask.folderPath}/${selectedTask.filename}`
          : selectedTask.filename
        void revealFile(fp)
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
        if (selectedTask.status === 'complete') {
          const fp = selectedTask.folderPath
            ? `${selectedTask.folderPath}/${selectedTask.filename}`
            : selectedTask.filename
          void openFile(fp)
        } else {
          void runTaskAction(selectedTask, 'toggle')
        }
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
      if (onboarding || cleanupOpen || pendingDelete || shortcutsOpen || commandsOpen || composing || settings || proOpen) return
      if (action === 'new-download') openComposer()
      else if (action === 'open-settings') setSettings(true)
      else if (action === 'focus-search') document.getElementById('ndm-search')?.focus()
    })

    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [settings, contextMenu, composing, selectedIds, selectedTask, keyboardTasks, onboarding, proOpen, cleanupOpen, shortcutsOpen, commandsOpen, pendingDelete, destinationTaskID, requestDelete, runTaskAction])

  const [isDragging, setIsDragging] = useState(false)
  const [dropTargetHot, setDropTargetHot] = useState(false)
  const dropDialogRef = useRef<HTMLDivElement | null>(null)
  const dropTargetHotRef = useRef(false)
  const [dropIssue, setDropIssue] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const dropIssueTimer = useRef<number | null>(null)
  const [confirmResumeAll, setConfirmResumeAll] = useState(false)
  const confirmResumeTimer = useRef<number | null>(null)
  const [libraryAction, setLibraryAction] = useState<'pause' | 'resume' | 'retry' | null>(null)
  const libraryActionBusy = libraryAction !== null

  const activeCount = tasks.filter((t) => t.status === 'downloading').length
  const recordingCount = tasks.filter((task) => task.status === 'downloading' && task.isLiveRecording).length
  const pausedCount = tasks.filter((t) => t.status === 'paused' || t.status === 'incomplete').length
  const failedIds = useMemo(
    () => tasks.filter((t) => t.status === 'error').map((t) => t.id),
    [tasks]
  )

  const runLibraryAction = async (action: 'pause' | 'resume'): Promise<void> => {
    if (libraryActionBusy) return
    setLibraryAction(action)
    setLibraryActionError('')
    setTaskActionError('')
    try {
      if (action === 'pause') await pauseAll()
      else await resumeAll()
      cue('success')
    } catch {
      setLibraryActionError(
        action === 'pause'
          ? '未能暂停全部任务。请重试。'
          : '未能继续已暂停任务。请重试。'
      )
      cue('droplet')
    } finally {
      setLibraryAction(null)
    }
  }

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
  const handleResumeAll = (): void => {
    if (libraryActionBusy) return
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
    if (libraryActionBusy || failedIds.length === 0) return
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
  const batchTaskBusyRef = useRef(false)
  const selectedTasks = tasks.filter((task) => selectedIds.has(task.id))
  const selectedPauseCount = selectedTasks.filter((task) => task.status === 'downloading').length
  const selectedResumeCount = selectedTasks.filter((task) => task.status !== 'downloading' && task.status !== 'complete').length

  // Snapshots may remove successful rows from the active filter. Keep the
  // batch result until dismissal or the next attempt, independently of selection.

  const runBatchTaskAction = async (action: 'resume' | 'pause'): Promise<void> => {
    if (batchTaskBusyRef.current) return
    const ids = Array.from(selectedIds).filter((id) => {
      const task = tasks.find((candidate) => candidate.id === id)
      return action === 'resume'
        ? task && task.status !== 'downloading' && task.status !== 'complete'
        : task?.status === 'downloading'
    })
    if (ids.length === 0) return

    batchTaskBusyRef.current = true
    setBatchTaskAction(action)
    setBatchTaskError('')
    let acknowledged = 0
    for (const id of ids) {
      try {
        await setTaskPaused(id, action === 'pause')
        acknowledged += 1
      } catch {
        // Keep processing: one stale or failed row must not hide the batch result.
      }
    }
    if (acknowledged === ids.length) {
      cue('success')
    } else {
      const verb = action === 'resume' ? '继续' : '暂停'
      setBatchTaskError(
        acknowledged === 0
          ? `未能${verb}所选任务。请重试。`
          : `只${verb}了 ${acknowledged}/${ids.length} 个任务。请检查剩余任务后重试。`
      )
      cue('droplet')
    }
    batchTaskBusyRef.current = false
    setBatchTaskAction(null)
  }

  const handleBatchCopy = (): void => {
    const urls = tasks.filter((t) => selectedIds.has(t.id)).map((t) => t.url).join('\n')
    if (urls) {
      void copyToClipboard(urls)
      cue('tick')
    }
  }

  const handleBatchDelete = (deleteFile: boolean): void => {
    requestDelete(Array.from(selectedIds), deleteFile)
  }

  const runFileCommand = async (task: Task, kind: 'open' | 'preview' | 'reveal' | 'share' | 'copy' | 'source'): Promise<void> => {
    const current = getTasks().find(candidate => candidate.id === task.id)
    if (!current) { setPreviewNotice({ message: '这个任务已不在列表中' }); return }
    const path = current.folderPath ? `${current.folderPath}/${current.filename}` : current.filename
    const failures = { open: '暂时无法打开文件，请重试', preview: '找不到文件，无法预览', reveal: `无法在${FILE_MANAGER}中显示文件`, share: '暂时无法分享文件，请重试', copy: '未能复制链接，请重试', source: '暂时无法打开来源网页' }
    try {
      let ok = true
      if (kind === 'preview') ok = await quickLook(path)
      else if (kind === 'open') ok = !(await openFile(path))
      else if (kind === 'reveal') ok = await revealFile(path)
      else if (kind === 'share') ok = await shareFile(path)
      else if (kind === 'source') ok = Boolean(current.pageURL) && await openExternal(current.pageURL!)
      else { await copyToClipboard(current.url); cue('tick') }
      if (!ok) setPreviewNotice({ message: failures[kind] })
    } catch { setPreviewNotice({ message: failures[kind] }) }
  }

  const commandItems: CommandPaletteItem[] = [
    { id: 'new-download', label: '添加下载', detail: '粘贴一个链接，或准备一批下载', keywords: ['new', 'download', 'add', '新建', '批量'], shortcut: `${COMMAND_KEY} N`, onSelect: () => openComposer() },
    { id: 'search', label: '搜索下载任务', keywords: ['find', 'search', '查找', '文件', '网站'], shortcut: `${COMMAND_KEY} F`, onSelect: () => { const search = document.getElementById('ndm-search') as HTMLInputElement | null; search?.focus(); search?.select() } },
    { id: 'settings', label: '设置', detail: '外观、声音、下载与浏览器连接', keywords: ['settings', 'preferences', '主题', '网络'], shortcut: `${COMMAND_KEY} ,`, onSelect: () => setSettings(true) },
    { id: 'shortcuts', label: '键盘快捷键', keywords: ['keyboard', 'shortcuts', '帮助'], shortcut: '?', onSelect: () => setShortcutsOpen(true) },
    { id: 'welcome', label: '重看使用引导', keywords: ['welcome', 'onboarding', '入门', '演示'], onSelect: () => setOnboarding(true) }
  ]
  if (selectedTask) {
    const task = selectedTask
    const done = task.status === 'complete'
    const working = task.status === 'downloading'
    const mainLabel = task.awaitingDestination ? '选择保存位置' : done ? '打开文件' : working ? task.isLiveRecording ? '停止并保存' : '暂停下载' : task.status === 'error' ? '重试下载' : '继续下载'
    commandItems.unshift(
      { id: 'task-primary', scope: 'selection', label: mainLabel, keywords: done ? ['open', '打开'] : working ? ['pause', 'stop', '暂停', '停止'] : task.status === 'error' ? ['retry', '重试'] : ['resume', '继续'], shortcut: 'Enter', disabled: Boolean(taskAction), onSelect: () => { if (done && !task.awaitingDestination) void runFileCommand(task, 'open'); else void runTaskAction(task, 'toggle') } },
      ...(done ? [{ id: 'task-restart', scope: 'selection' as const, label: '重新下载', keywords: ['retry', 'restart', '重试'], disabled: Boolean(taskAction), onSelect: () => void runTaskAction(task, 'restart') }] : []),
      { id: 'task-preview', scope: 'selection', label: '快速预览', detail: done ? undefined : '下载完成后可用', keywords: ['preview', 'quicklook', '空格'], shortcut: 'Space', disabled: !done, onSelect: () => void runFileCommand(task, 'preview') },
      { id: 'task-reveal', scope: 'selection', label: `在${FILE_MANAGER}中显示`, keywords: ['finder', 'reveal', 'explorer', '保存位置'], shortcut: `${COMMAND_KEY} R`, disabled: !done, onSelect: () => void runFileCommand(task, 'reveal') },
      { id: 'task-copy', scope: 'selection', label: '复制下载链接', keywords: ['copy', 'url', '网址'], shortcut: `${COMMAND_KEY} C`, onSelect: () => void runFileCommand(task, 'copy') },
      { id: 'task-share', scope: 'selection', label: '分享文件', keywords: ['share', '发送'], disabled: !done, onSelect: () => void runFileCommand(task, 'share') },
      ...(task.pageURL ? [{ id: 'task-source', scope: 'selection' as const, label: '打开来源网页', keywords: ['source', 'website', '网站'], onSelect: () => void runFileCommand(task, 'source') }] : []),
      { id: 'task-delete', scope: 'selection', label: '删除任务…', detail: '下一步选择是否同时删除文件', keywords: ['delete', 'remove', '移除'], shortcut: 'Delete', onSelect: () => requestDelete([task.id]) }
    )
  } else if (selectedTasks.length > 1) {
    commandItems.unshift(
      { id: 'selection-copy', scope: 'selection', label: '复制所选下载链接', keywords: ['copy', 'links', '批量'], onSelect: handleBatchCopy },
      { id: 'selection-delete', scope: 'selection', label: '删除所选任务…', detail: '下一步选择是否同时删除文件', keywords: ['delete', 'remove', '批量'], onSelect: () => requestDelete(selectedTasks.map(task => task.id)) }
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
          onOpenCommands={() => { setCommandsOpen(true); cue('press') }}
          onToggleSidebar={() => setSidebarMode(document.getElementById('main-sidebar')?.getBoundingClientRect().width ? 'closed' : 'open')}
          inspectorAvailable={Boolean(selectedTask)}
          inspectorOpen={Boolean(selectedTask && dismissedInspector !== selectedTask.id)}
          onToggleInspector={() => setDismissedInspector(selectedTask && dismissedInspector !== selectedTask.id ? selectedTask.id : null)}
          filter={filter} count={visible.length} query={query} onQuery={changeQuery} sort={taskSort} onSort={setTaskSort}>
          <div className="app-no-drag flex min-w-0 items-center gap-2 text-[11px]">
            <div className="min-w-0 flex items-center gap-2">
              {activeCount > 0 ? <span className="flex size-1.5 shrink-0 rounded-full bg-sage" /> : null}
              <span
                id="library-action-summary"
                role="status"
                aria-live="polite"
                className={`min-w-0 truncate ${activeCount > 0 ? 'font-medium text-paper' : 'text-mist'}`}
              >
                {libraryAction === 'pause'
                  ? '正在暂停全部任务…'
                  : libraryAction === 'resume'
                    ? '正在继续已暂停任务…'
                    : libraryAction === 'retry'
                      ? '正在重试失败任务…'
                      : activeCount > 0
                        ? recordingCount > 0 ? `${recordingCount} 个录制中${activeCount > recordingCount ? ` · ${activeCount - recordingCount} 个下载中` : ''}` : `${activeCount} 个下载中 · ${formatSpeed(totalBytesPerSec).value} ${formatSpeed(totalBytesPerSec).unit}`
                        : pausedCount > 0
                          ? ''
                          : ''}
              </span>
            </div>
            <div className="app-no-drag flex shrink-0 items-center gap-1.5">
              {activeCount > 0 ? (
                <button
                  type="button"
                  data-cuelume-press="tick"
                  disabled={libraryActionBusy}
                  aria-describedby={libraryActionError ? 'library-action-status' : undefined}
                  onClick={() => void runLibraryAction('pause')}
                  className="ndm-toolbar-action rounded-full border border-line px-2.5 py-0.5 text-mist transition-[background-color,color,scale] duration-100 hover:bg-line hover:text-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
                >
                  {tasks.some((task) => task.status === 'downloading' && task.isLiveRecording) ? libraryAction === 'pause' ? '正在停止…' : '暂停下载并保存直播' : libraryAction === 'pause' ? '暂停中…' : '全部暂停'}
                </button>
              ) : null}
              {pausedCount > 0 && filter === 'paused' ? (
                <button
                  type="button"
                  data-cuelume-press="tick"
                  disabled={libraryActionBusy}
                  aria-describedby={libraryActionError ? 'library-action-status' : undefined}
                  onClick={handleResumeAll}
                  className={`ndm-toolbar-action shrink-0 rounded-full border px-2.5 py-0.5 transition-[background-color,color,scale] duration-100 active:scale-[0.96] disabled:cursor-wait disabled:opacity-50 ${
                    confirmResumeAll
                      ? 'border-copper/60 bg-copper/12 font-medium text-copper'
                      : 'border-line text-mist hover:bg-line hover:text-paper'
                  }`}
                >
                  {libraryAction === 'resume' ? '继续中…' : confirmResumeAll ? `确认继续 ${pausedCount} 项` : `继续已暂停 (${pausedCount})`}
                </button>
              ) : null}
            </div>
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

        {/* Selection actions participate in layout, so banners and small windows cannot cover rows. */}
        {selectedIds.size > 1 || batchTaskBusy || batchTaskError ? (
          <div
            role="toolbar"
            aria-label="批量任务操作"
            aria-busy={batchTaskBusy}
            className="mx-4 my-2 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-copper/30 bg-raised px-3 py-2.5 animate-fade-down"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] font-medium text-paper">
              <span className="shrink-0 rounded-md bg-copper/20 px-2 py-0.5 text-copper font-mono text-[11.5px]">
                已选 {selectedIds.size} 项
              </span>
              {batchTaskError ? (
                <span
                  id="batch-task-action-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-[11.5px] font-normal text-clay"
                >
                  {batchTaskError}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <button
                type="button"
                disabled={batchTaskBusy || selectedResumeCount === 0}
                aria-describedby={batchTaskError ? 'batch-task-action-status' : undefined}
                onClick={() => void runBatchTaskAction('resume')}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Play size={12} />
                <span>{batchTaskAction === 'resume' ? '继续中…' : '全部继续'}</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy || selectedPauseCount === 0}
                aria-describedby={batchTaskError ? 'batch-task-action-status' : undefined}
                onClick={() => void runBatchTaskAction('pause')}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Pause size={12} />
                <span>{selectedTasks.some((task) => task.isLiveRecording && task.status === 'downloading') ? batchTaskAction === 'pause' ? '正在停止…' : '暂停下载并保存直播' : batchTaskAction === 'pause' ? '暂停中…' : '全部暂停'}</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy || selectedIds.size === 0}
                onClick={handleBatchCopy}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Copy size={12} />
                <span>复制链接</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy || selectedIds.size === 0}
                onClick={() => handleBatchDelete(false)}
                className="flex items-center gap-1 rounded-lg bg-clay/15 px-2.5 py-1 font-medium text-clay hover:bg-clay/25 transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Trash2 size={12} />
                <span>批量删除</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy}
                onClick={() => { setSelectedIds(new Set()); setBatchTaskError('') }}
                className="rounded-lg p-1 text-mist hover:text-paper ml-1 disabled:cursor-wait disabled:opacity-50"
                title="取消选择"
                aria-label="取消选择"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}

        {/* Failed-filter recovery banner: the bucket's own next steps, in place. */}
        {filter === 'failed' && failedIds.length > 0 ? (
          <div className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-line bg-raised/60 px-6 py-1.5">
            <span className="flex min-w-0 items-center gap-2 text-meta text-fog">
              <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-clay" />
              <span className="min-w-0 truncate">{failedIds.length} 个失败任务 · 查看详情了解原因</span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                data-cuelume-press="tick"
                disabled={libraryActionBusy}
                aria-describedby={libraryActionError ? 'library-action-status' : undefined}
                onClick={() => void retryAllFailed()}
                className="h-control rounded-control border border-line px-2.5 text-label text-fog transition-colors hover:bg-line hover:text-paper disabled:opacity-50"
              >
                {libraryAction === 'retry' ? '重试中…' : '重试全部'}
              </button>
            </div>
          </div>
        ) : null}

        {/* Hero Active Card (for single active download when on all/active filter) */}
        {hero ? (
          <Hero
            task={hero}
            actionBusy={taskAction?.taskID === hero.id}
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
          transferView={filter === 'active'}
          tasks={rest}
          allTasks={tasks}
          selectedIds={selectedIds}
          celebratingIds={celebratingIds}
          expandedCollections={displayedCollections}
          empty={!hero ? <EmptyState loading={!libraryReady} filter={filter} query={query} onNew={() => openComposer()} onClearSearch={() => { changeQuery(''); document.getElementById('ndm-search')?.focus() }} onShowAll={() => { setFilter('all'); setSelectedIds(new Set()) }} /> : null}
          onSelect={handleSelectTask}
          onContextMenu={handleRowContextMenu}
          onToggleCollection={toggleCollection}
          onExpandCollection={expandCollection}
          actionBusyTaskID={taskAction?.taskID}
          actionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
          installProgress={installProgress}
          sort={taskSort}
          onSort={handleTaskSort}
        />

        <TransferActivity
          notice={completionNotice}
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
          taskActionBusy={taskAction?.taskID === selectedTask.id}
          taskActionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
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
