import './ui/workspace.css'
import { Menu } from '@base-ui/react/menu'
import { ArrowDownWideNarrow, Check, Search, X } from 'lucide-react'
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

export function LibraryToolbar({ filter, count, query, onQuery, sort, onSort }: {
  filter: FilterId
  count: number
  query: string
  onQuery: (query: string) => void
  sort: TaskSort
  onSort: (sort: TaskSort) => void
}) {
  const searching = Boolean(query.trim())
  return (
    <div className="app-no-drag flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-b border-line/60 px-6 py-4">
      <div className="mr-auto flex min-w-0 items-baseline gap-2.5">
        <h1 className="text-[20px] font-semibold tracking-[-0.025em] text-paper">{WORKSPACE_LABELS[filter]}</h1>
        <span id="workspace-result-count" role="status" aria-live="polite" aria-atomic="true" className="text-[11.5px] tabular-nums text-mist">
          {searching ? `${count} 项匹配` : `${count} 项`}
        </span>
      </div>
      <div className="flex min-w-0 flex-[1_1_240px] items-center gap-2 sm:max-w-[360px]">
        <div role="search" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-line bg-raised/55 px-2.5 text-fog transition-colors focus-within:border-copper/60 focus-within:bg-raised">
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
            className="min-w-0 w-full bg-transparent text-[12px] text-paper outline-none placeholder:text-mist [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={() => { onQuery(''); document.getElementById('ndm-search')?.focus() }} className="grid size-6 shrink-0 place-items-center rounded text-mist hover:bg-line hover:text-paper">
              <X size={13} aria-hidden />
            </button>
          ) : <kbd aria-hidden className="shrink-0 whitespace-nowrap rounded border border-line px-1 text-[10px] text-mist">{COMMAND_KEY} F</kbd>}
        </div>
        <Menu.Root>
          <Menu.Trigger aria-label="排序下载任务" title="排序下载任务" className="grid size-9 shrink-0 place-items-center rounded-control border border-line text-fog transition-colors hover:bg-raised hover:text-paper data-[popup-open]:bg-raised data-[popup-open]:text-paper">
            <ArrowDownWideNarrow size={16} aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={8} align="end" className="z-[70] outline-none">
              <Menu.Popup className="workspace-sort-menu min-w-[208px] rounded-xl border border-line-strong bg-raised p-1.5 text-[12.5px] text-paper shadow-popover outline-none">
                <Menu.Group>
                  <Menu.GroupLabel className="px-2.5 pb-2 pt-1.5 text-[11px] font-medium text-mist">排列方式</Menu.GroupLabel>
                  <Menu.RadioGroup value={sortValue(sort)} onValueChange={(value) => {
                    const option = SORT_OPTIONS.find((candidate) => sortValue(candidate.sort) === value)
                    if (option) onSort(option.sort)
                  }}>
                    {SORT_OPTIONS.map((option) => (
                      <Menu.RadioItem key={sortValue(option.sort)} value={sortValue(option.sort)} className="flex cursor-default items-center gap-2 rounded-control px-2.5 py-2 outline-none data-[highlighted]:bg-line">
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
      </div>
    </div>
  )
}
