import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Copy, Pause, Play, Search, Trash2, X, ArrowDown } from 'lucide-react'
import { ClipboardToast } from './components/ClipboardToast'
import { CompletionBar, type CompletionNotice } from './components/CompletionBar'
import { Composer } from './components/Composer'
import { ContextMenu, type ContextMenuPosition } from './components/ContextMenu'
import { Hero } from './components/Hero'
import { Inspector } from './components/Inspector'
import { Onboarding } from './components/Onboarding'
import { Confetti, type ConfettiRef } from './components/ui/confetti'
import { ProModal } from './components/ProModal'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { VirtualTaskList } from './components/VirtualTaskList'
import { EmptyState } from './components/EmptyState'
import { Gallery } from './Gallery'
import { formatSpeed } from './lib/format'
import { cue } from './lib/sound'
import {
  addFromUrl,
  copyToClipboard,
  filterTasks,
  openFile,
  pauseAll,
  quickLook,
  readClipboard,
  remove,
  removeMany,
  restartTask,
  resumeAll,
  revealFile,
  toggle
} from './lib/store'
import { resolveSharedLink } from './lib/sharedLink'
import { hasOnboarded, markOnboarded, resetOnboarding } from './lib/license'
import { readStoredTheme, themeById, writeStoredTheme, type ThemeId } from './lib/themes'
import { buildDisplayItems, visualTasks } from './lib/taskList'
import type { FilterId, Task } from './lib/types'
import { useEngineStatus, useTasks } from './lib/useStore'

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

export default function App() {
  const query = params()
  const gallery = query.get('gallery') === '1'
  const embed = query.get('embed') === '1'
  const [themeId, setThemeId] = useState<ThemeId>(() => themeById(query.get('theme') ?? readStoredTheme()).id)
  const theme = themeById(themeId)

  useEffect(() => {
    document.documentElement.dataset.theme = gallery ? 'walnut' : theme.id
    document.title = gallery ? 'NDM · 选方向' : `NDM · ${theme.name}`
    if (!gallery && !embed) writeStoredTheme(theme.id)
  }, [gallery, embed, theme.id])

  const applyTheme = (id: ThemeId): void => {
    setThemeId(id)
    writeStoredTheme(id)
    const next = new URL(window.location.href)
    next.searchParams.delete('gallery')
    next.searchParams.set('theme', id)
    history.replaceState(null, '', next)
  }

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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null)
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  // The paywall carries the capability the user just reached for, so it can
  // answer "why am I seeing this" instead of pitching cold.
  const [proReason, setProReason] = useState<string | null>(null)
  const [proOpen, setProOpen] = useState(false)
  const [proRedeem, setProRedeem] = useState(false)
  const [onboarding, setOnboarding] = useState(() => !embed && !hasOnboarded())
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null)
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const [dismissedClipUrl, setDismissedClipUrl] = useState<string | null>(null)
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null)
  const [celebratingIds, setCelebratingIds] = useState<Set<number>>(new Set())
  const knownStatuses = useRef<Map<number, Task['status']>>(new Map())
  const celebrationTimers = useRef<Map<number, number>>(new Map())
  const confettiRef = useRef<ConfettiRef | null>(null)

  const visible = useMemo(() => filterTasks(filter, query), [filter, query, tasks])
  const hero =
    visible.find((task) => task.status === 'downloading') ??
    (filter === 'all' ? tasks.find((task) => task.status === 'downloading') : undefined)
  const rest = visible.filter((task) => task.id !== hero?.id)
  const visibleRows = useMemo(
    () => visualTasks(buildDisplayItems(rest, tasks, expandedCollections)),
    [expandedCollections, rest, tasks]
  )

  // Single active selected task for Inspector
  const singleSelectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const selectedTask = singleSelectedId ? (tasks.find((task) => task.id === singleSelectedId) ?? null) : null

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

    // A moment worth celebrating: a copper burst from the bottom of the window.
    confettiRef.current?.fire({
      particleCount: 90,
      spread: 70,
      startVelocity: 38,
      origin: { x: 0.5, y: 1 },
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
    },
    []
  )

  // Clipboard link sniffer on window focus. Uses the same shared-link
  // resolver as the composer, so 分享口令 (Douyin/Bilibili/小红书 share text)
  // triggers the toast exactly like a bare media URL does.
  useEffect(() => {
    const checkClipboard = async (): Promise<void> => {
      const text = (await readClipboard())?.trim() ?? ''
      if (!text) return
      const resolution = resolveSharedLink(text)
      if (!resolution || resolution.urlString === dismissedClipUrl) return
      const isKnownMediaSite = resolution.source !== 'web'
      const isDownloadishFile =
        /\.(dmg|zip|pkg|tar|gz|7z|rar|mp4|mkv|mov|avi|mp3|m4a|pdf|iso|exe|apk|bin|flv|m3u8)($|\?)/i.test(
          resolution.urlString
        )
      if ((isKnownMediaSite || isDownloadishFile) && resolution.urlString !== clipboardUrl) {
        setClipboardUrl(resolution.urlString)
      }
    }
    window.addEventListener('focus', checkClipboard)
    void checkClipboard()
    return () => window.removeEventListener('focus', checkClipboard)
  }, [dismissedClipUrl, clipboardUrl])

  const openComposer = (prefillUrl?: string): void => {
    setComposerPrefill(prefillUrl ?? null)
    setComposing(true)
    cue('bloom')
  }

  const closeComposer = (): void => {
    setComposing(false)
    setComposerPrefill(null)
    cue('droplet')
  }

  const openPro = (reason?: string): void => {
    setProReason(reason ?? null)
    setProRedeem(false)
    setProOpen(true)
    cue('bloom')
  }

  const openRedeem = (): void => {
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

  // Keyboard navigation & shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (typing) return

      // Onboarding and the paywall are modal: they own the keyboard while up.
      if (onboarding) return
      if (proOpen) {
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
          void toggle(selectedTask.id)
        }
        return
      }

      // Delete (Delete / Backspace / Cmd+Backspace)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.size > 0) {
        event.preventDefault()
        const deleteFile = event.metaKey || event.ctrlKey
        void removeMany(Array.from(selectedIds), deleteFile)
        setSelectedIds(new Set())
        cue('droplet')
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
  }, [settings, contextMenu, composing, selectedIds, selectedTask, visibleRows, lastClickedIndex, onboarding, proOpen])

  const [isDragging, setIsDragging] = useState(false)
  const [confirmResumeAll, setConfirmResumeAll] = useState(false)
  const confirmResumeTimer = useRef<number | null>(null)

  // Resuming a large historical library is destructive-adjacent: thousands of
  // stale tasks would start at once. Ask for a second click when it's big.
  const handleResumeAll = (): void => {
    if (pausedCount > 20 && !confirmResumeAll) {
      setConfirmResumeAll(true)
      if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
      confirmResumeTimer.current = window.setTimeout(() => setConfirmResumeAll(false), 4000)
      return
    }
    if (confirmResumeTimer.current) window.clearTimeout(confirmResumeTimer.current)
    setConfirmResumeAll(false)
    void resumeAll()
  }

  const activeCount = tasks.filter((t) => t.status === 'downloading').length
  const pausedCount = tasks.filter((t) => t.status === 'paused' || t.status === 'incomplete').length
  const totalBytesPerSec = tasks
    .filter((t) => t.status === 'downloading')
    .reduce((sum, t) => sum + (t.bytesPerSecond || 0), 0)

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
    if (text) {
      const match = text.match(/https?:\/\/[^\s]+/i) || text.match(/ftp:\/\/[^\s]+/i)
      const url = match ? match[0] : text.trim()
      if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('ftp://')) {
        void addFromUrl(url).then((t) => {
          setSelectedIds(new Set([t.id]))
          cue('success')
        })
      }
    }
  }

  // Batch actions
  const handleBatchResume = (): void => {
    for (const id of selectedIds) {
      const task = tasks.find((t) => t.id === id)
      if (task && task.status !== 'downloading' && task.status !== 'complete') {
        void toggle(id)
      }
    }
  }

  const handleBatchPause = (): void => {
    for (const id of selectedIds) {
      const task = tasks.find((t) => t.id === id)
      if (task && task.status === 'downloading') {
        void toggle(id)
      }
    }
  }

  const handleBatchCopy = (): void => {
    const urls = tasks.filter((t) => selectedIds.has(t.id)).map((t) => t.url).join('\n')
    if (urls) {
      void copyToClipboard(urls)
      cue('tick')
    }
  }

  const handleBatchDelete = (deleteFile: boolean): void => {
    void removeMany(Array.from(selectedIds), deleteFile)
    setSelectedIds(new Set())
    cue('droplet')
  }

  return (
    <div
      className="relative flex h-full bg-ink text-paper select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag & Drop Visual Overlay — full-window copper vignette + glass card */}
      {isDragging ? (
        <motion.div
          key="drop-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
          style={{
            background:
              'radial-gradient(120% 120% at 50% 50%, transparent 30%, color-mix(in srgb, var(--accent) 12%, transparent) 75%, color-mix(in srgb, var(--accent) 22%, transparent) 100%), color-mix(in srgb, var(--ink) 78%, transparent)'
          }}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-[22px] border border-line-strong bg-raised/85 px-10 py-8 text-center shadow-[0_30px_80px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            style={{ boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent), 0 30px 80px rgba(0,0,0,0.4)' }}
          >
            <motion.span
              className="grid size-14 place-items-center rounded-full bg-copper/15 text-copper"
              animate={{ scale: [1, 1.08, 1] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <ArrowDown size={26} strokeWidth={1.8} />
            </motion.span>
            <div className="font-serif text-[24px] leading-none text-paper">释放以添加下载</div>
            <p className="text-[12px] text-mist">将链接、文件或视频拖入即可自动解析并开始高速下载</p>
          </div>
        </motion.div>
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
      />

      <main className="relative flex flex-1 flex-col overflow-hidden">
        {/* Top Header Toolbar */}
        <header className="app-drag flex h-[52px] shrink-0 items-center justify-between border-b border-line px-6">
          <div className="min-w-0 flex items-center gap-3 text-[12px]">
            {activeCount > 0 ? (
              <div className="min-w-0 flex items-center gap-2">
                <span className="flex size-2 rounded-full bg-copper animate-pulse" />
                <span className="min-w-0 truncate font-medium text-paper">
                  {activeCount} 个任务下载中 · {formatSpeed(totalBytesPerSec).value}{' '}
                  {formatSpeed(totalBytesPerSec).unit}
                </span>
                <button
                  type="button"
                  onClick={() => void pauseAll()}
                  className="app-no-drag ml-1 shrink-0 rounded-full border border-line px-2.5 py-0.5 text-mist transition-colors hover:bg-line hover:text-paper"
                >
                  全部暂停
                </button>
              </div>
            ) : pausedCount > 0 ? (
              <div className="min-w-0 flex items-center gap-2">
                <span className="min-w-0 truncate text-mist">{pausedCount} 个任务已暂停</span>
                <button
                  type="button"
                  onClick={handleResumeAll}
                  className={`app-no-drag shrink-0 rounded-full border px-2.5 py-0.5 transition-colors ${
                    confirmResumeAll
                      ? 'border-copper/60 bg-copper/12 font-medium text-copper'
                      : 'border-line text-mist hover:bg-line hover:text-paper'
                  }`}
                >
                  {confirmResumeAll ? `确认继续全部 ${pausedCount} 项？` : '全部继续'}
                </button>
              </div>
            ) : (
              <span className="text-mist font-medium">任务就绪</span>
            )}
          </div>

          <label className="app-no-drag flex h-8 w-[clamp(150px,22vw,240px)] shrink-0 items-center gap-2 rounded-[9px] border border-line bg-panel px-2.5 text-[13px] text-fog max-[800px]:hidden">
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

        {/* Batch Selection Action Floating Bar */}
        {selectedIds.size > 1 ? (
          <div className="absolute top-[60px] inset-x-6 z-30 flex items-center justify-between rounded-xl border border-copper/40 bg-raised/98 px-4 py-2 shadow-2xl backdrop-blur-xl animate-fade-down">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-paper">
              <span className="rounded-md bg-copper/20 px-2 py-0.5 text-copper font-mono text-[11.5px]">
                已选 {selectedIds.size} 项
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <button
                type="button"
                onClick={handleBatchResume}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors"
              >
                <Play size={12} />
                <span>全部继续</span>
              </button>
              <button
                type="button"
                onClick={handleBatchPause}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors"
              >
                <Pause size={12} />
                <span>全部暂停</span>
              </button>
              <button
                type="button"
                onClick={handleBatchCopy}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-fog hover:text-paper transition-colors"
              >
                <Copy size={12} />
                <span>复制链接</span>
              </button>
              <button
                type="button"
                onClick={() => handleBatchDelete(false)}
                className="flex items-center gap-1 rounded-lg bg-clay/15 px-2.5 py-1 font-medium text-clay hover:bg-clay/25 transition-colors"
              >
                <Trash2 size={12} />
                <span>批量删除</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="rounded-lg p-1 text-mist hover:text-paper ml-1"
                title="取消选择"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}

        {/* Hero Active Card (for single active download when on all/active filter) */}
        {hero && filter !== 'completed' && filter !== 'failed' && filter !== 'paused' && filter !== 'queued' ? (
          <Hero task={hero} />
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
        />

        {/* Clipboard Link Sniffer Toast */}
        {clipboardUrl ? (
          <ClipboardToast
            url={clipboardUrl}
            onDownload={(url) => {
              setClipboardUrl(null)
              openComposer(url)
            }}
            onDismiss={() => {
              setDismissedClipUrl(clipboardUrl)
              setClipboardUrl(null)
            }}
          />
        ) : null}
      </main>

      {/* Right Detail Inspector Panel */}
      {selectedTask && selectedIds.size === 1 ? (
        <Inspector
          task={selectedTask}
          onClose={() => {
            setSelectedIds(new Set())
          }}
          onUpgrade={openPro}
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

      {/* Pro paywall + local redeem sheet */}
      <ProModal open={proOpen} reason={proReason} startInRedeem={proRedeem} onClose={() => setProOpen(false)} />

      {/* First-run onboarding — never over the gallery or the embed view */}
      {!embed ? <Onboarding open={onboarding} onFinish={finishOnboarding} /> : null}

      {/* Completion celebration canvas — mounted once, fired on task completion */}
      <Confetti
        ref={confettiRef}
        manualstart
        className="pointer-events-none fixed inset-0 z-50"
        globalOptions={{ useWorker: true, resize: true }}
      />

      {/* Right-click Context Menu */}
      {contextMenu ? (
        <ContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onToggle={(t) => void toggle(t.id)}
          onRestart={(t) => void restartTask(t.id)}
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
            void remove(t.id, deleteFile)
            setSelectedIds((prev) => {
              const next = new Set(prev)
              next.delete(t.id)
              return next
            })
            cue('droplet')
          }}
        />
      ) : null}
    </div>
  )
}
