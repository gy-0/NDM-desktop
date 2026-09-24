import './ui/workspace.css'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { Search, X, PanelLeft, PanelRight } from 'lucide-react'
import { COMMAND_KEY } from '../lib/platform'
import { WORKSPACE_LABELS } from '../lib/workspace'
import type { FilterId } from '../lib/types'
import { useWindowChromeLayout } from '../lib/useWindowChromeLayout'
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference'
import { AnimatedCount } from './ui/AnimatedCount'

function ContextualToolbar({ children }: { children: ReactNode }) {
  const present = useIsPresent()
  const reduced = useReducedMotionPreference()
  const layerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!present && layerRef.current?.contains(document.activeElement)) {
      document.getElementById('ndm-search')?.focus({ preventScroll: true })
    }
  }, [present])
  return <motion.div ref={layerRef} className="library-context app-no-drag" data-context-visible={present}
    inert={!present} aria-hidden={!present || undefined}
    initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: reduced ? 0 : 4 }}
    transition={{ duration: reduced ? 0 : .15, ease: 'easeOut' }}>
    {children}
  </motion.div>
}

export function LibraryToolbar({ layoutControl, filter, count, query, onQuery, children, sidebarOpen, onToggleSidebar, onToggleInspector, inspectorAvailable, inspectorOpen, title, headingControls, viewControls, contextualToolbar, transferControl }: {
  layoutControl?: ReactNode
  title?: string
  headingControls?: ReactNode
  contextualToolbar?: ReactNode
  transferControl?: ReactNode
  viewControls?: ReactNode
  onToggleSidebar?: () => void
  sidebarOpen?: boolean
  onToggleInspector?: () => void
  inspectorAvailable?: boolean
  inspectorOpen?: boolean
  children?: ReactNode
  filter: FilterId
  count: number
  query: string
  onQuery: (query: string) => void
}) {
  const searching = Boolean(query.trim())
  const selecting = Boolean(contextualToolbar)
  const { toolbarRef } = useWindowChromeLayout()
  return (
    <div ref={toolbarRef} className="library-toolbar app-drag shrink-0" data-selection-toolbar={selecting || undefined}>
      <div className="library-search app-drag flex min-w-0 items-center gap-2">
        <button type="button" aria-label="切换侧栏" title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-controls="main-sidebar" aria-expanded={sidebarOpen} onClick={onToggleSidebar} className="grid size-control shrink-0 place-items-center rounded-control text-fog transition-colors hover:bg-raised"><PanelLeft size={16} /></button>
        {/* The page title shares the titlebar row: a second header row only
            pushed the library down. The title drags the window like any
            titlebar text (its buttons opt out via the rule in workspace.css);
            a no-drag region here re-shapes the drag area on every sidebar
            frame. Selection mode takes over the title slot; search and view
            controls stay usable. */}
        <div className="library-title-slot">
          <div inert={selecting} aria-hidden={selecting || undefined} className="library-heading flex min-w-0 items-baseline gap-2">
            <h1 className="min-w-0 truncate text-heading font-semibold tracking-[-0.015em] text-paper" title={title}>{title ?? WORKSPACE_LABELS[filter]}</h1>
            <span id="workspace-result-count" role="status" aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-meta tabular-nums text-mist">
              <AnimatedCount value={count} />{searching ? ' 项匹配' : ' 项'}
            </span>
            {headingControls}
          </div>
          <AnimatePresence initial={false}>
            {selecting ? <ContextualToolbar key="selection">{contextualToolbar}</ContextualToolbar> : null}
          </AnimatePresence>
        </div>
        {transferControl}
        <div role="search" className="flex h-field min-w-[160px] w-full max-w-[300px] shrink items-center gap-2 rounded-control border border-line bg-raised/55 px-3 text-fog transition-colors focus-within:border-copper/60 focus-within:bg-raised">
          <Search size={14} aria-hidden className="shrink-0 text-mist" />
          <input
            id="ndm-search"
            type="search"
            aria-label="搜索下载任务"
            aria-describedby="workspace-result-count"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              if (query) onQuery('')
              else event.currentTarget.blur()
            }}
            placeholder="搜索文件、网站或链接"
            className="min-w-0 w-full bg-transparent text-label text-paper outline-none placeholder:text-mist/80 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={() => { onQuery(''); document.getElementById('ndm-search')?.focus() }} className="grid size-6 shrink-0 place-items-center rounded text-mist hover:bg-line hover:text-paper">
              <X size={13} aria-hidden />
            </button>
          ) : <kbd aria-hidden className="shrink-0 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-meta leading-none text-mist">{COMMAND_KEY} F</kbd>}
        </div>
        {layoutControl}
        {viewControls}
        {/* The pane toggle owns the top-right corner: that is where the eye
            goes for the right-hand pane. View options sit one step inboard. */}
        <button
          type="button"
          aria-label="切换任务详情"
          title="切换任务详情"
          aria-pressed={inspectorOpen || false}
          disabled={!inspectorAvailable}
          onClick={onToggleInspector}
          className="grid size-control shrink-0 place-items-center rounded-control text-fog transition-colors hover:bg-raised hover:text-paper aria-pressed:bg-raised aria-pressed:shadow-[inset_0_0_0_1px_var(--line)] aria-pressed:text-paper disabled:opacity-35"
        >
          <PanelRight size={16} />
        </button>
      </div>
      <div className="library-actions" inert={selecting} aria-hidden={selecting || undefined}>{children}</div>
    </div>
  )
}
