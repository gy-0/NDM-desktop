import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Copy, Pause, Play, Search, Trash2, X, ArrowDown } from 'lucide-react'
import { ClipboardToast } from './components/ClipboardToast'
import { CleanupModal } from './components/CleanupModal'
import { CompletionBar, type CompletionNotice } from './components/CompletionBar'
import { InstallProgress, type InstallProgressPhase, type InstallProgressState } from './components/InstallProgress'
import { Composer } from './components/Composer'
import { ContextMenu, type ContextMenuPosition } from './components/ContextMenu'
import { DeleteTasksDialog } from './components/DeleteTasksDialog'
import { Hero } from './components/Hero'
import { Inspector } from './components/Inspector'
import { Onboarding } from './components/Onboarding'
import { Confetti, type ConfettiRef } from './components/ui/confetti'
import { MetalForgePreview } from './effects/metalforge/MetalForgePreview'
import { DropField, ProductMotionLab } from './effects/metalforge/ProductMotion'
import { ProModal } from './components/ProModal'
import { Settings } from './components/Settings'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { Sidebar } from './components/Sidebar'
import { VirtualTaskList } from './components/VirtualTaskList'
import { EmptyState } from './components/EmptyState'
import { Gallery } from './Gallery'
import { formatSpeed } from './lib/format'
import { dragCarriesDownloadLink, resolveDroppedInput } from './lib/dropInput'
import { cue } from './lib/sound'
import {
  copyToClipboard,
  filterTasks,
  openFile,
  pauseAll,
  quickLook,
  removeMany,
  restartMany,
  restartTask,
  resumeAll,
  revealFile,
  toggle
} from './lib/store'
import { useClipboardOffer } from './lib/useClipboardOffer'
import { COMMERCIALIZATION_DRAFT_ENABLED } from './lib/commercialization'
import { hasOnboarded, markOnboarded, resetOnboarding } from './lib/onboarding'
import { readStoredTheme, themeById, writeStoredTheme, type ThemeId } from './lib/themes'
import { buildDisplayItems, readTaskSort, sortTasks, visualTasks, writeTaskSort, type TaskSort, type TaskSortKey } from './lib/taskList'
import type { FilterId, Task } from './lib/types'
import { useEngineStatus, useTasks } from './lib/useStore'

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
  const engineStatus = useEngineStatus()
  const [filter, setFilter] = useState<FilterId>('all')
  const [query, setQuery] = useState('')
  const [taskSort, setTaskSort] = useState<TaskSort>(readTaskSort)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null)
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Retain the commercial UI draft without presenting it in the open Beta.
  const [proReason, setProReason] = useState<string | null>(null)
  const [proOpen, setProOpen] = useState(false)
  const [proRedeem, setProRedeem] = useState(false)
  const [onboarding, setOnboarding] = useState(() => !embed && !hasOnboarded())
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ ids: number[]; preferredDeleteFile: boolean } | null>(null)
  const [deletingPendingTasks, setDeletingPendingTasks] = useState(false)
  const [pendingDeleteError, setPendingDeleteError] = useState('')
  const [libraryActionError, setLibraryActionError] = useState('')
  const [taskAction, setTaskAction] = useState<{ taskID: number; kind: 'toggle' | 'restart' } | null>(null)
  const [taskActionError, setTaskActionError] = useState('')
  const taskActionBusyRef = useRef(false)
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null)
  const installProgressTimer = useRef<number | null>(null)
  const [celebratingIds, setCelebratingIds] = useState<Set<number>>(new Set())
  const knownStatuses = useRef<Map<number, Task['status']>>(new Map())
  const celebrationTimers = useRef<Map<number, number>>(new Map())
  const confettiRef = useRef<ConfettiRef | null>(null)
  const clipboard = useClipboardOffer(tasks, composing)

  const runTaskAction = useCallback(async (task: Task, kind: 'toggle' | 'restart'): Promise<void> => {
    if (taskActionBusyRef.current) return
    taskActionBusyRef.current = true
    setTaskAction({ taskID: task.id, kind })
    setTaskActionError('')
    setLibraryActionError('')
    try {
      if (kind === 'restart') await restartTask(task.id)
      else await toggle(task.id)
      cue('success')
    } catch {
      const verb = kind === 'restart' ? '重试' : task.status === 'downloading' ? '暂停' : '继续'
      setTaskActionError(`未能${verb}“${task.filename || task.title}”。请检查下载引擎后重试。`)
      cue('droplet')
    } finally {
      taskActionBusyRef.current = false
      setTaskAction(null)
    }
  }, [])

  const visible = useMemo(() => filterTasks(filter, query), [filter, query, tasks])
  const sortedVisible = useMemo(() => sortTasks(visible, taskSort), [taskSort, visible])
  const hero =
    sortedVisible.find((task) => task.status === 'downloading') ??
    (filter === 'all' ? sortTasks(tasks, taskSort).find((task) => task.status === 'downloading') : undefined)
  const rest = sortedVisible.filter((task) => task.id !== hero?.id)
  const visibleRows = useMemo(
    () => visualTasks(buildDisplayItems(rest, tasks, expandedCollections)),
    [expandedCollections, rest, tasks]
  )

  // Single active selected task for Inspector
  const singleSelectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const selectedTask = singleSelectedId ? (tasks.find((task) => task.id === singleSelectedId) ?? null) : null

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
    if (!prefillUrl) void clipboard.consumeGeneration()
    setComposerPrefill(prefillUrl ?? null)
    setComposing(true)
    setSettings(false)
    setContextMenu(null)
    cue('bloom')
  }

  const closeComposer = (): void => {
    setComposing(false)
    setComposerPrefill(null)
    cue('droplet')
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

  const finishOnboarding = (): void => {
    markOnboarded()
    setOnboarding(false)
  }

  useEffect(() => {
    return window.ndm?.onEvent((message) => {
      if (message.op === 'installProgress') {
        const path = typeof message.path === 'string' ? message.path : ''
        const phase = typeof message.phase === 'string' ? message.phase as InstallProgressPhase : null
        if (!path || !phase) return
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
        setComposerPrefill(url)
        setComposing(true)
        setSettings(false)
        setContextMenu(null)
        cue('bloom')
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

  // Handle task selection with Shift & Cmd/Ctrl modifiers.
  // Reads mutable state through refs so the callback identity stays stable
  // for memoized rows while never seeing stale ranges.
  const visibleRowsRef = useRef(visibleRows)
  visibleRowsRef.current = visibleRows
  const lastClickedRef = useRef(lastClickedIndex)
  lastClickedRef.current = lastClickedIndex

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

  const handleSelectTask = useCallback((e: React.MouseEvent, task: Task, index: number): void => {
    cue('tick')
    if (e.metaKey || e.ctrlKey) {
      // Toggle selection
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(task.id)) next.delete(task.id)
        else next.add(task.id)
        return next
      })
      setLastClickedIndex(index)
    } else if (e.shiftKey && lastClickedRef.current !== null) {
      // Range selection
      const anchor = lastClickedRef.current
      const start = Math.min(anchor, index)
      const end = Math.max(anchor, index)
      const rangeIds = visibleRowsRef.current.slice(start, end + 1).map((t) => t.id)
      setSelectedIds(new Set(rangeIds))
    } else {
      // Single select
      setSelectedIds(new Set([task.id]))
      setLastClickedIndex(index)
    }
  }, [])

  const handleRowContextMenu = useCallback((e: React.MouseEvent, task: Task): void => {
    setSelectedIds((prev) => (prev.has(task.id) ? prev : new Set([task.id])))
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
        : '未能删除所选任务。请检查下载引擎后重试。')
    } finally {
      setDeletingPendingTasks(false)
    }
  }

  useEffect(() => {
    const existing = new Set(tasks.map((task) => task.id))
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => existing.has(id)))
      return next.size === current.size ? current : next
    })
  }, [tasks])

  // Keyboard navigation & shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (typing) return

      // Onboarding and the dormant commercial draft are modal when present.
      if (onboarding) return
      if (cleanupOpen) {
        // The cleanup sheet owns Escape via its capture listener; ignore
        // everything else so shell shortcuts can't fire underneath it.
        return
      }
      if (pendingDelete) return
      if (COMMERCIALIZATION_DRAFT_ENABLED && proOpen) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setProOpen(false)
          cue('release')
        }
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
        setSelectedIds(new Set(visibleRows.map((t) => t.id)))
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
      if (event.key === ' ' && selectedTask) {
        event.preventDefault()
        const fp = selectedTask.folderPath
          ? `${selectedTask.folderPath}/${selectedTask.filename}`
          : selectedTask.filename
        void quickLook(fp)
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
        if (visibleRows.length === 0) return
        const currentIndex = selectedTask
          ? visibleRows.findIndex((task) => task.id === selectedTask.id)
          : lastClickedIndex
        const nextIdx = currentIndex == null || currentIndex < 0
          ? event.key === 'ArrowDown' ? 0 : visibleRows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(visibleRows.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1)
        const nextTask = visibleRows[nextIdx]
        if (nextTask) {
          if (event.shiftKey && currentIndex != null && currentIndex >= 0) {
            const start = Math.min(currentIndex, nextIdx)
            const end = Math.max(currentIndex, nextIdx)
            setSelectedIds(new Set(visibleRows.slice(start, end + 1).map((task) => task.id)))
          } else {
            setSelectedIds(new Set([nextTask.id]))
          }
          setLastClickedIndex(nextIdx)
        }
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
      if (action === 'new-download') openComposer()
      else if (action === 'open-settings') setSettings(true)
      else if (action === 'focus-search') document.getElementById('ndm-search')?.focus()
    })

    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [settings, contextMenu, composing, selectedIds, selectedTask, visibleRows, lastClickedIndex, onboarding, proOpen, cleanupOpen, shortcutsOpen, pendingDelete, requestDelete, runTaskAction])

  const [isDragging, setIsDragging] = useState(false)
  const [dragAcceptsLink, setDragAcceptsLink] = useState(false)
  const [dropIssue, setDropIssue] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const dropIssueTimer = useRef<number | null>(null)
  const [confirmResumeAll, setConfirmResumeAll] = useState(false)
  const confirmResumeTimer = useRef<number | null>(null)
  const [libraryAction, setLibraryAction] = useState<'pause' | 'resume' | 'retry' | null>(null)
  const libraryActionBusy = libraryAction !== null

  const activeCount = tasks.filter((t) => t.status === 'downloading').length
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
          ? '未能暂停全部任务。请检查下载引擎后重试。'
          : '未能继续已暂停任务。请检查下载引擎后重试。'
      )
      cue('droplet')
    } finally {
      setLibraryAction(null)
    }
  }

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
      setLibraryActionError('未能重试失败任务。请检查下载引擎后重试。')
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
    },
    []
  )

  const handleDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current += 1
    clearDropIssue()
    setDragAcceptsLink(dragCarriesDownloadLink(Array.from(e.dataTransfer.types)))
    setIsDragging(true)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const accepted = dragCarriesDownloadLink(Array.from(e.dataTransfer.types))
    e.dataTransfer.dropEffect = accepted ? 'copy' : 'none'
    setDragAcceptsLink(accepted)
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setIsDragging(false)

    const resolution = resolveDroppedInput({
      uriList: e.dataTransfer.getData('text/uri-list'),
      plainText: e.dataTransfer.getData('text/plain'),
      hasFiles: e.dataTransfer.files.length > 0
    })
    if (resolution.accepted) {
      openComposer(resolution.link.urlString)
      return
    }
    showDropIssue(
      resolution.reason === 'localFile'
        ? '本地文件已经在这台 Mac 上，NDM 不会复制或上传它'
        : '没有识别到可下载的链接，请拖入网页链接、文件直链或磁力链'
    )
  }

  // Batch actions
  const [batchTaskAction, setBatchTaskAction] = useState<'resume' | 'pause' | null>(null)
  const [batchTaskError, setBatchTaskError] = useState('')
  const batchTaskBusy = batchTaskAction !== null

  useEffect(() => {
    setBatchTaskError('')
  }, [selectedIds])

  const runBatchTaskAction = async (action: 'resume' | 'pause'): Promise<void> => {
    if (batchTaskBusy) return
    const ids = Array.from(selectedIds).filter((id) => {
      const task = tasks.find((candidate) => candidate.id === id)
      return action === 'resume'
        ? task && task.status !== 'downloading' && task.status !== 'complete'
        : task?.status === 'downloading'
    })
    if (ids.length === 0) return

    setBatchTaskAction(action)
    setBatchTaskError('')
    let acknowledged = 0
    for (const id of ids) {
      try {
        await toggle(id)
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
          ? `未能${verb}所选任务。请检查下载引擎后重试。`
          : `只${verb}了 ${acknowledged}/${ids.length} 个任务。请检查剩余任务后重试。`
      )
      cue('droplet')
    }
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

  return (
    <div
      className="relative flex h-full min-w-0 overflow-hidden bg-ink text-paper select-none"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag & drop needs a clear target, not a decorative takeover. */}
      {isDragging ? (
        <motion.div
          key="drop-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink/92"
        >
          {dragAcceptsLink ? <DropField /> : null}
          <div className="relative flex w-[min(460px,calc(100%-48px))] items-start gap-4 rounded-xl border border-line-strong bg-raised/95 px-6 py-5 shadow-[0_16px_36px_-18px_rgb(0_0_0/0.72)]">
            <ArrowDown size={22} strokeWidth={1.8} className="mt-0.5 shrink-0 text-fog" />
            <div className="min-w-0">
              <div className="text-[18px] font-semibold leading-tight text-paper">
                {dragAcceptsLink ? '释放以检查下载' : '请拖入下载链接'}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-mist">
                {dragAcceptsLink
                  ? '支持网页、文件直链、媒体链接和磁力链；确认后再开始'
                  : '本地文件已经在这台 Mac 上，NDM 不会复制或上传它'}
              </p>
            </div>
          </div>
        </motion.div>
      ) : null}

      {dropIssue ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-[12px] text-fog shadow-[0_12px_28px_-16px_rgb(0_0_0/0.72)]"
        >
          {dropIssue}
        </div>
      ) : null}

      <Sidebar
        filter={filter}
        engineStatus={engineStatus}
        onFilter={(f) => {
          setFilter(f)
          setSelectedIds(new Set())
          setLastClickedIndex(null)
        }}
        onNew={() => openComposer()}
        onSettings={() => setSettings(true)}
        onCleanup={() => {
          setCleanupOpen(true)
          cue('page')
        }}
      />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main id="main-content" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top Header Toolbar */}
        <header className="app-drag flex h-[52px] shrink-0 items-center justify-between border-b border-line px-6">
          <div className="min-w-0 flex items-center gap-3 text-[12px]">
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
                        ? `${activeCount} 个下载中 · ${formatSpeed(totalBytesPerSec).value} ${formatSpeed(totalBytesPerSec).unit}${pausedCount > 0 ? ` · ${pausedCount} 个已暂停` : ''}`
                        : pausedCount > 0
                          ? `${pausedCount} 个任务已暂停`
                          : '任务就绪'}
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
                  className="rounded-full border border-line px-2.5 py-0.5 text-mist transition-[background-color,color,scale] duration-100 hover:bg-line hover:text-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
                >
                  {libraryAction === 'pause' ? '暂停中…' : '全部暂停'}
                </button>
              ) : null}
              {pausedCount > 0 ? (
                <button
                  type="button"
                  data-cuelume-press="tick"
                  disabled={libraryActionBusy}
                  aria-describedby={libraryActionError ? 'library-action-status' : undefined}
                  onClick={handleResumeAll}
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 transition-[background-color,color,scale] duration-100 active:scale-[0.96] disabled:cursor-wait disabled:opacity-50 ${
                    confirmResumeAll
                      ? 'border-copper/60 bg-copper/12 font-medium text-copper'
                      : 'border-line text-mist hover:bg-line hover:text-paper'
                  }`}
                >
                  {libraryAction === 'resume' ? '继续中…' : confirmResumeAll ? `确认继续 ${pausedCount} 项` : '继续已暂停'}
                </button>
              ) : null}
            </div>
          </div>

          <label className="app-no-drag flex h-8 w-[clamp(170px,24vw,260px)] shrink-0 items-center gap-2 rounded-[7px] border border-line bg-raised/55 px-2.5 text-[13px] text-fog max-[800px]:hidden focus-within:border-line-strong">
            <Search size={13} />
            <input
              id="ndm-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名或网站"
              className="w-full bg-transparent outline-none placeholder:text-mist text-[12px]"
            />
            <kbd className="grid size-[18px] place-items-center rounded-[5px] border border-line text-[10px] text-mist">
              /
            </kbd>
          </label>
        </header>

        {libraryActionError ? (
          <div
            id="library-action-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-clay/30 bg-clay/[0.08] px-6 py-1.5 text-[11.5px] text-clay"
          >
            <span>{libraryActionError}</span>
            <button
              type="button"
              aria-label="关闭批量操作提示"
              onClick={() => setLibraryActionError('')}
              className="shrink-0 rounded-md p-0.5 text-clay/70 transition-colors hover:bg-clay/10 hover:text-clay"
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
            className="animate-fade-down flex shrink-0 items-center justify-between gap-3 border-b border-clay/30 bg-clay/[0.08] px-6 py-1.5 text-[11.5px] text-clay"
          >
            <span className="truncate" title={taskActionError}>{taskActionError}</span>
            <button
              type="button"
              aria-label="关闭任务操作提示"
              onClick={() => setTaskActionError('')}
              className="shrink-0 rounded-md p-0.5 text-clay/70 transition-colors hover:bg-clay/10 hover:text-clay"
            >
              <X size={13} />
            </button>
          </div>
        ) : null}

        {/* Batch Selection Action Floating Bar */}
        {selectedIds.size > 1 ? (
          <div
            role="toolbar"
            aria-label="批量任务操作"
            aria-busy={batchTaskBusy}
            style={{
              top: 60
                + (libraryActionError || taskActionError ? 32 : 0)
                + (filter === 'failed' && failedIds.length > 0 ? 32 : 0)
            }}
            className="absolute inset-x-6 z-30 flex items-center justify-between gap-3 rounded-xl border border-copper/40 bg-raised/98 px-4 py-2 shadow-2xl backdrop-blur-xl transition-[top] animate-fade-down"
          >
            <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium text-paper">
              <span className="shrink-0 rounded-md bg-copper/20 px-2 py-0.5 text-copper font-mono text-[11.5px]">
                已选 {selectedIds.size} 项
              </span>
              {batchTaskError ? (
                <span
                  id="batch-task-action-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="truncate text-[11.5px] font-normal text-clay"
                >
                  {batchTaskError}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <button
                type="button"
                disabled={batchTaskBusy}
                aria-describedby={batchTaskError ? 'batch-task-action-status' : undefined}
                onClick={() => void runBatchTaskAction('resume')}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Play size={12} />
                <span>{batchTaskAction === 'resume' ? '继续中…' : '全部继续'}</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy}
                aria-describedby={batchTaskError ? 'batch-task-action-status' : undefined}
                onClick={() => void runBatchTaskAction('pause')}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Pause size={12} />
                <span>{batchTaskAction === 'pause' ? '暂停中…' : '全部暂停'}</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy}
                onClick={handleBatchCopy}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Copy size={12} />
                <span>复制链接</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy}
                onClick={() => handleBatchDelete(false)}
                className="flex items-center gap-1 rounded-lg bg-clay/15 px-2.5 py-1 font-medium text-clay hover:bg-clay/25 transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                <Trash2 size={12} />
                <span>批量删除</span>
              </button>
              <button
                type="button"
                disabled={batchTaskBusy}
                onClick={() => setSelectedIds(new Set())}
                className="rounded-lg p-1 text-mist hover:text-paper ml-1 disabled:cursor-wait disabled:opacity-50"
                title="取消选择"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}

        {/* Failed-filter recovery banner: the bucket's own next steps, in place. */}
        {filter === 'failed' && failedIds.length > 0 ? (
          <div className="animate-fade-down flex shrink-0 items-center justify-between border-b border-line bg-clay/[0.07] px-6 py-1.5">
            <span className="text-[11.5px] text-clay">
              {failedIds.length} 个失败任务 · 链接过期或站点拒绝
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-cuelume-press="tick"
                disabled={libraryActionBusy}
                aria-describedby={libraryActionError ? 'library-action-status' : undefined}
                onClick={() => void retryAllFailed()}
                className="rounded-full border border-clay/50 bg-clay/10 px-2.5 py-0.5 text-[11px] font-medium text-clay transition-colors hover:bg-clay/20 disabled:opacity-50"
              >
                {libraryAction === 'retry' ? '重试中…' : '重试全部'}
              </button>
              <button
                type="button"
                data-cuelume-press="page"
                onClick={() => {
                  setCleanupOpen(true)
                  cue('page')
                }}
                className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-fog transition-colors hover:bg-line hover:text-paper"
              >
                整理任务库
              </button>
            </div>
          </div>
        ) : null}

        {/* Hero Active Card (for single active download when on all/active filter) */}
        {hero && filter !== 'completed' && filter !== 'failed' && filter !== 'paused' && filter !== 'queued' ? (
          <Hero
            task={hero}
            actionBusy={taskAction?.taskID === hero.id}
            actionErrorId={taskActionError ? 'task-action-status' : undefined}
            onToggle={(task) => void runTaskAction(task, 'toggle')}
          />
        ) : null}

        {/* Task List */}
        <VirtualTaskList
          tasks={rest}
          allTasks={tasks}
          selectedIds={selectedIds}
          celebratingIds={celebratingIds}
          expandedCollections={expandedCollections}
          empty={!hero ? <EmptyState filter={filter} onNew={() => openComposer()} /> : null}
          onSelect={handleSelectTask}
          onContextMenu={handleRowContextMenu}
          onToggleCollection={toggleCollection}
          onExpandCollection={expandCollection}
          actionBusyTaskID={taskAction?.taskID}
          actionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
          sort={taskSort}
          onSort={handleTaskSort}
        />

        <CompletionBar
          notice={completionNotice}
          onDismiss={() => setCompletionNotice(null)}
          onOpen={(notice) => {
            void openFile(notice.fullPath)
            setCompletionNotice(null)
          }}
          onReveal={(notice) => {
            void revealFile(notice.fullPath)
            setCompletionNotice(null)
          }}
        />

        <InstallProgress
          progress={installProgress}
          onDismiss={() => setInstallProgress(null)}
        />

        {/* Composer Modal */}
        <Composer
          open={composing}
          initialUrl={composerPrefill}
          onClose={closeComposer}
          onCreated={(id, count = 1) => {
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
      </main>

      {selectedTask && selectedIds.size === 1 ? (
        <Inspector
          task={selectedTask}
          taskActionBusy={taskAction?.taskID === selectedTask.id}
          taskActionErrorId={taskActionError ? 'task-action-status' : undefined}
          onTaskToggle={(task) => void runTaskAction(task, 'toggle')}
          onTaskRestart={(task) => void runTaskAction(task, 'restart')}
          onClose={() => {
            setSelectedIds(new Set())
          }}
          onUpgrade={openPro}
        />
      ) : null}
      </div>

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

      {/* Library cleanup sheet — bulk retry / remove for heavy libraries */}
      <CleanupModal
        open={cleanupOpen}
        onClose={() => {
          setCleanupOpen(false)
          setSelectedIds(new Set())
        }}
      />

      {/* Keyboard shortcuts cheat sheet — press ? anywhere */}
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Preserved for later real entitlement work; never exposed in Beta. */}
      {COMMERCIALIZATION_DRAFT_ENABLED ? (
        <ProModal open={proOpen} reason={proReason} startInRedeem={proRedeem} onClose={() => setProOpen(false)} />
      ) : null}

      {/* First-run onboarding — never over the gallery or the embed view */}
      {!embed ? <Onboarding open={onboarding} onFinish={finishOnboarding} /> : null}

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
