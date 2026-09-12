import './ui/workspace.css'
import type { ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { ArrowDownWideNarrow, Check, Search, X, PanelLeft, PanelRight } from 'lucide-react'
import { COMMAND_KEY } from '../lib/platform'
import type { TaskSort } from '../lib/taskList'
import { WORKSPACE_LABELS } from '../lib/workspace'
import type { FilterId } from '../lib/types'

const SORT_OPTIONS: { label: string; sort: TaskSort }[] = [
  { label: '最近活动', sort: { key: 'activity', direction: 'desc' } },
  { label: '最早活动', sort: { key: 'activity', direction: 'asc' } },
  { label: '文件名 A → Z', sort: { key: 'filename', direction: 'asc' } },
  { label: '文件名 Z → A', sort: { key: 'filename', direction: 'desc' } },
  { label: '文件大小 · 从大到小', sort: { key: 'size', direction: 'desc' } },
  { label: '下载进度 · 从高到低', sort: { key: 'progress', direction: 'desc' } },
  { label: '任务状态', sort: { key: 'status', direction: 'asc' } }
]
const sortValue = (sort: TaskSort): string => `${sort.key}:${sort.direction}`

export function LibraryToolbar({ filter, count, query, onQuery, sort, onSort, children, onToggleSidebar, onToggleInspector, inspectorAvailable, inspectorOpen, onOpenCommands, title, headingControls, contextualToolbar, transferControl }: {
  title?: string
  headingControls?: ReactNode
  contextualToolbar?: ReactNode
  transferControl?: ReactNode
  onOpenCommands?: () => void
  onToggleSidebar?: () => void
  onToggleInspector?: () => void
  inspectorAvailable?: boolean
  inspectorOpen?: boolean
  children?: ReactNode
  filter: FilterId
  count: number
  query: string
  onQuery: (query: string) => void
  sort: TaskSort
  onSort: (sort: TaskSort) => void
}) {
  const searching = Boolean(query.trim())
  return (
    <div className="library-toolbar app-drag shrink-0" data-selection-toolbar={Boolean(contextualToolbar) || undefined}>
      <div className="library-heading app-no-drag flex min-w-0 items-baseline gap-2.5">
        <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-[-0.025em] text-paper" title={title}>{title ?? WORKSPACE_LABELS[filter]}</h1>
        <span id="workspace-result-count" role="status" aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-[12px] tabular-nums text-mist">
          {searching ? `${count} 项匹配` : `${count} 项`}
        </span>
        {headingControls}
      </div>
      {contextualToolbar ? <div className="library-context app-no-drag">{contextualToolbar}</div> : null}
      <div className="library-search app-no-drag flex min-w-0 items-center gap-2">
        <button type="button" aria-label="切换侧栏" onClick={onToggleSidebar} className="grid size-control shrink-0 place-items-center rounded-control text-fog transition-colors hover:bg-raised"><PanelLeft size={16} /></button>
        <span className="min-w-0 flex-1" />
        {transferControl}
        <div role="search" className="flex h-field min-w-0 w-full max-w-[360px] items-center gap-2 rounded-control border border-line bg-raised/55 px-3 text-fog transition-colors focus-within:border-copper/60 focus-within:bg-raised">
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
        <button type="button" aria-label="快速操作" title={`快速操作 (${COMMAND_KEY} K)`} onClick={onOpenCommands}
          className="h-control shrink-0 rounded-control border border-line px-2.5 text-label text-fog transition-colors hover:bg-raised hover:text-paper">操作</button>
        <Menu.Root>
          <Menu.Trigger aria-label="排序下载任务" title="排序下载任务" className="grid size-control shrink-0 place-items-center rounded-control border border-line text-fog transition-colors hover:bg-raised hover:text-paper data-[popup-open]:bg-raised data-[popup-open]:text-paper">
            <ArrowDownWideNarrow size={16} aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={8} align="end" className="z-[70] outline-none">
              <Menu.Popup className="workspace-sort-menu min-w-[208px] rounded-surface border border-line-strong bg-raised p-1.5 text-label text-paper shadow-popover outline-none">
                <Menu.Group>
                  <Menu.GroupLabel className="px-2.5 pb-2 pt-1.5 text-meta font-medium text-mist">排列方式</Menu.GroupLabel>
                  <Menu.RadioGroup value={sortValue(sort)} onValueChange={(value) => {
                    const option = SORT_OPTIONS.find((candidate) => sortValue(candidate.sort) === value)
                    if (option) onSort(option.sort)
                  }}>
                    {SORT_OPTIONS.map((option) => (
                      <Menu.RadioItem closeOnClick key={sortValue(option.sort)} value={sortValue(option.sort)} className="flex cursor-default items-center gap-2 rounded-control px-2.5 py-2 outline-none data-[highlighted]:bg-line">
                        <span className="grid size-4 place-items-center"><Menu.RadioItemIndicator><Check size={13} aria-hidden /></Menu.RadioItemIndicator></span>
                        {option.label}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Group>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {/* The pane toggle owns the top-right corner: that is where the eye
            goes for the right-hand pane. Sorting sits one step inboard. */}
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
      <div className="library-actions">{children}</div>
    </div>
  )
}
