import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Composer } from './components/Composer'
import { Hero } from './components/Hero'
import { Inspector } from './components/Inspector'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { TaskRow } from './components/TaskRow'
import { Gallery } from './Gallery'
import { filterTasks } from './lib/store'
import { cue } from './lib/sound'
import { readStoredTheme, themeById, writeStoredTheme, type ThemeId } from './lib/themes'
import type { FilterId } from './lib/types'
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
  const [selectedId, setSelectedId] = useState<number | null>(1)
  const [composing, setComposing] = useState(false)
  const [settings, setSettings] = useState(false)

  const visible = useMemo(() => filterTasks(filter, query), [filter, query, tasks])
  const hero =
    visible.find((task) => task.status === 'downloading') ??
    tasks.find((task) => task.status === 'downloading')
  const rest = visible.filter((task) => task.id !== hero?.id)
  const selected = tasks.find((task) => task.id === selectedId) ?? null

  const openComposer = (): void => {
    setComposing(true)
    cue('bloom')
  }

  const closeComposer = (): void => {
    setComposing(false)
    cue('droplet')
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        setSettings((open) => !open)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        openComposer()
        return
      }
      if (event.key === 'Escape') {
        if (settings) {
          setSettings(false)
          return
        }
        closeComposer()
        return
      }
      if (!typing && event.key === '/') {
        event.preventDefault()
        document.getElementById('ndm-search')?.focus()
        return
      }
      if (!typing && event.key === 'n') openComposer()
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
  }, [settings])

  const [isDragging, setIsDragging] = useState(false)

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
          setSelectedId(t.id)
          cue('success')
        })
      }
    }
  }

  return (
    <div
      className="relative flex h-full bg-ink text-paper"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag & Drop Visual Overlay */}
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-copper bg-ink/80 backdrop-blur-sm">
          <div className="rounded-2xl border border-line-strong bg-raised px-8 py-6 text-center shadow-2xl">
            <div className="font-serif text-[24px] text-copper">释放以添加下载</div>
            <p className="mt-1 text-[12px] text-mist">将 URL 或链接拖入即可自动解析并开始高速下载</p>
          </div>
        </div>
      ) : null}

      <Sidebar
        filter={filter}
        engineStatus={engineStatus}
        onFilter={setFilter}
        onNew={openComposer}
        onSettings={() => setSettings(true)}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="app-drag flex h-[52px] shrink-0 items-center justify-between gap-2 px-5">
          {/* Header Stats / Batch Actions */}
          <div className="app-no-drag flex items-center gap-3 text-[12px]">
            {activeCount > 0 ? (
              <div className="flex items-center gap-2 rounded-full border border-copper/30 bg-copper/10 px-2.5 py-0.5 text-copper">
                <span className="size-1.5 rounded-full bg-copper animate-pulse" />
                <span>{activeCount} 个下载中</span>
              </div>
            ) : null}

            {activeCount > 0 ? (
              <button
                type="button"
                onClick={() => void pauseAll()}
                className="rounded-full border border-line px-2.5 py-0.5 text-mist transition-colors hover:bg-line hover:text-paper"
              >
                全部暂停
              </button>
            ) : pausedCount > 0 ? (
              <button
                type="button"
                onClick={() => void resumeAll()}
                className="rounded-full border border-line px-2.5 py-0.5 text-mist transition-colors hover:bg-line hover:text-paper"
              >
                全部继续
              </button>
            ) : null}
          </div>

          <label className="app-no-drag flex h-8 w-[240px] items-center gap-2 rounded-[9px] border border-line bg-panel px-2.5 text-[13px] text-fog">
            <Search size={13} />
            <input
              id="ndm-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名或网站"
              className="w-full bg-transparent outline-none placeholder:text-mist"
            />
            <kbd className="grid size-[18px] place-items-center rounded-[5px] border border-line text-[10px] text-mist">
              /
            </kbd>
          </label>
        </header>

        {hero && filter !== 'completed' && filter !== 'failed' && filter !== 'paused' && filter !== 'queued' ? (
          <Hero task={hero} />
        ) : null}

        <section className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-quiet">
          {rest.length === 0 && !hero ? (
            <Empty filter={filter} onNew={openComposer} />
          ) : (
            <ul className="flex flex-col gap-2">
              {rest.map((task, index) => (
                <li key={task.id}>
                  <TaskRow
                    task={task}
                    selected={task.id === selectedId}
                    index={index}
                    onSelect={() => setSelectedId(task.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <Composer
          open={composing}
          onClose={closeComposer}
          onCreated={(id) => {
            setSelectedId(id)
            cue('success')
          }}
        />
      </main>
      {selected ? (
        <Inspector
          task={selected}
          onClose={() => {
            setSelectedId(null)
            cue('droplet')
          }}
        />
      ) : null}
      {!embed ? (
        <Settings
          open={settings}
          themeId={themeId}
          onTheme={onTheme}
          onClose={() => setSettings(false)}
        />
      ) : null}
    </div>
  )
}

function Empty({ filter, onNew }: { filter: FilterId; onNew: () => void }) {
  return (
    <div className="grid h-full place-items-center text-center">
      <div>
        <div className="font-serif text-[32px]">没有下载</div>
        <p className="mt-2 text-[13px] text-mist">
          {filter === 'all' ? '添加一个链接即可开始。' : '这类里还没有项目。'}
        </p>
        <button
          type="button"
          data-cuelume-press
          data-cuelume-release
          onClick={onNew}
          className="mt-5 rounded-full border border-line-strong px-3.5 py-1.5 text-[13px]"
        >
          添加下载
        </button>
      </div>
    </div>
  )
}
