import { coveredTrailingColumns, fitTableColumns, fitLibraryColumns, tableColumnMinimums, TABLE_KEYS } from '../lib/tableLayout'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { completedDragPaths } from '../lib/fileDrag'
import { buildDisplayItems, visualTasks } from '../lib/taskList'
import type { TaskSort, TaskSortKey } from '../lib/taskList'
import type { Task } from '../lib/types'
import { CollectionRow } from './CollectionRow'
import { TaskRow } from './TaskRow'
import type { InstallProgressState } from './TransferActivity'

type ColumnKey = 'filename' | 'status' | 'size' | 'activity' | 'progress'
type ColumnWidths = Record<ColumnKey, number>

const COLUMN_WIDTHS_KEY = 'ndm-task-column-widths-v3'
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  filename: 340,
  status: 96,
  size: 124,
  activity: 118,
  progress: 150
}

function readColumnWidths(): ColumnWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}') as Partial<ColumnWidths>
    return Object.fromEntries(
      (Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnKey[]).map((key) => {
        const value = Number(stored[key] ?? DEFAULT_COLUMN_WIDTHS[key])
        return [key, Number.isFinite(value) ? Math.min(5000, Math.max(1, value)) : DEFAULT_COLUMN_WIDTHS[key]]
      })
    ) as ColumnWidths
  } catch {
    return DEFAULT_COLUMN_WIDTHS
  }
}

export function VirtualTaskList({
  tasks,
  transferView = false,
  viewKey,
  allTasks,
  selectedIds,
  celebratingIds,
  expandedCollections,
  empty,
  onSelect,
  onContextMenu,
  onToggleCollection,
  onExpandCollection,
  actionBusyTaskID,
  actionErrorId,
  onTaskToggle,
  onFileCommand,
  onTaskRestart,
  installProgress,
  sort,
  onSort
}: {
  viewKey?: string
  transferView?: boolean
  tasks: Task[]
  allTasks: Task[]
  selectedIds: Set<number>
  celebratingIds: Set<number>
  expandedCollections: Set<string>
  empty: ReactNode
  onSelect: (event: React.MouseEvent, task: Task, index: number) => void
  onContextMenu: (event: React.MouseEvent, task: Task) => void
  onToggleCollection: (collectionID: string) => void
  onExpandCollection: (collectionID: string) => void
  actionBusyTaskID?: number
  actionErrorId?: string
  onFileCommand: (task: Task, action: 'open' | 'preview' | 'reveal') => void
  onTaskToggle: (task: Task) => void
  onTaskRestart: (task: Task) => void
  installProgress?: InstallProgressState | null
  sort: TaskSort
  onSort: (key: TaskSortKey) => void
}) {
  const dragSelection = useRef({ allTasks, selectedIds })
  dragSelection.current = { allTasks, selectedIds }
  const handleFileDrag = useCallback((task: Task): void => {
    const { allTasks, selectedIds } = dragSelection.current
    const files = completedDragPaths(task, allTasks, selectedIds)
    if (files.length) window.ndm?.startFileDrag?.(files)
  }, [])
  const scrollRef = useRef<HTMLElement>(null)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(readColumnWidths)
  const [resizingColumn, setResizingColumn] = useState<ColumnKey | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])
  const tableRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(900)
  useEffect(() => {
    const element = tableRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(Math.max(0, entry.contentRect.width - 32)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fitted = transferView ? fitTableColumns(availableWidth, columnWidths) : fitLibraryColumns(availableWidth, columnWidths)
  const minimums = tableColumnMinimums(availableWidth)
  const columnTemplate = TABLE_KEYS.filter(key => fitted[key] > 0).map(key => `${fitted[key]}px`).join(' ')
  // Stable string so memoized rows only re-render when coverage really moves.
  const coveredColumns = coveredTrailingColumns(fitted)
  const displayItems = useMemo(
    () => buildDisplayItems(tasks, allTasks, expandedCollections),
    [allTasks, expandedCollections, tasks]
  )
  const visualIndexById = useMemo(() => {
    const indexes = new Map<number, number>()
    visualTasks(displayItems).forEach((task, index) => indexes.set(task.id, index))
    return indexes
  }, [displayItems])

  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => displayItems[index]?.kind === 'collection' ? 72 : 68,
    getItemKey: (index) => {
      const item = displayItems[index]
      return item?.kind === 'collection' ? `collection:${item.id}` : `task:${item?.task.id ?? index}`
    },
    gap: 3,
    overscan: 8
  })

  useLayoutEffect(() => {
    // A new set of search/filter results starts at its first matching file.
    // Resizes and selection changes retain their existing scroll position.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    virtualizer.scrollToOffset(0)
  }, [viewKey])

  const singleSelectedId = selectedIds.size === 1 ? selectedIds.values().next().value : undefined
  const selectedTask = singleSelectedId === undefined ? undefined : allTasks.find((task) => task.id === singleSelectedId)

  useEffect(() => {
    const collectionID = selectedTask?.collection?.id
    if (!collectionID || expandedCollections.has(collectionID)) return
    onExpandCollection(collectionID)
  }, [expandedCollections, onExpandCollection, selectedTask?.collection?.id])

  const selectedIndex = singleSelectedId === undefined
    ? -1
    : displayItems.findIndex((item) => item.kind === 'task' && item.task.id === singleSelectedId)

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedIndex, virtualizer])

  useEffect(() => {
    if (!resizingColumn) localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths))
  }, [columnWidths, resizingColumn])

  const beginResize = (key: ColumnKey, event: React.PointerEvent<HTMLSpanElement>): void => {
    if (event.button !== 0) return
    resizeCleanup.current?.()
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = fitted[key]
    const neighbor = TABLE_KEYS.slice(TABLE_KEYS.indexOf(key) + 1).find(column => fitted[column] > 0)
    if (!neighbor) return
    const adjacentWidth = fitted[neighbor]
    const minimum = minimums[key]
    const neighborMinimum = minimums[neighbor]
    setResizingColumn(key)
    document.documentElement.dataset.resizingColumns = 'true'

    const move = (moveEvent: PointerEvent): void => {
      const delta = Math.max(minimum - startWidth, Math.min(adjacentWidth - neighborMinimum, moveEvent.clientX - startX))
      setColumnWidths({ ...columnWidths, ...Object.fromEntries(TABLE_KEYS.filter(column => fitted[column] > 0).map(column => [column, fitted[column]])), [key]: startWidth + delta, [neighbor]: adjacentWidth - delta })
    }
    const finish = (): void => {
      setResizingColumn(null)
      delete document.documentElement.dataset.resizingColumns
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      resizeCleanup.current = null
    }
    resizeCleanup.current = finish
    window.addEventListener('blur', finish)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resetColumn = (_key: ColumnKey): void => setColumnWidths(DEFAULT_COLUMN_WIDTHS)

  const adjustColumn = (key: ColumnKey, delta: number): void => {
    const neighbor = TABLE_KEYS.slice(TABLE_KEYS.indexOf(key) + 1).find(column => fitted[column] > 0)
    if (!neighbor) return
    const minimum = minimums[key]
    const nextMinimum = minimums[neighbor]
    const shift = Math.max(minimum - fitted[key], Math.min(fitted[neighbor] - nextMinimum, delta))
    setColumnWidths({ ...columnWidths, ...Object.fromEntries(TABLE_KEYS.filter(column => fitted[column] > 0).map(column => [column, fitted[column]])), [key]: fitted[key] + shift, [neighbor]: fitted[neighbor] - shift })
  }

  const collectionCount = useMemo(
    () => new Set(tasks.flatMap((task) => (task.collection ? [task.collection.id] : []))).size,
    [tasks],
  )

  return (
    <div ref={tableRef} data-library-view={!transferView || undefined} data-table-density={fitted.status === 0 ? "compact" : "full"} data-stacked-progress={fitted.progress === 0 || undefined} data-hide-size={fitted.size === 0 || undefined} data-hide-time={fitted.activity === 0 || undefined} className="task-table min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
      {tasks.length > 0 ? (
        <div className="task-table-header mx-4 grid h-9 shrink-0 items-stretch overflow-visible border-b border-line/70 text-[12px] text-fog" style={{ gridTemplateColumns: columnTemplate }}>
          <span className="relative flex h-full min-w-0 items-center overflow-visible ps-[75px] pe-3">
            <SortableHeader label="文件名" sortKey="filename" sort={sort} onSort={onSort} compact />
            <span className="ms-auto min-w-0 truncate ps-3 text-right font-mono tabular-nums text-mist">
              {collectionCount > 0 ? `${collectionCount.toLocaleString('zh-CN')} 个合集` : ''}
            </span>
            <ColumnResizeHandle column="filename" minimums={minimums} fitted={fitted} width={Math.round(fitted.filename)} active={resizingColumn === 'filename'} onResize={beginResize} onReset={resetColumn} onAdjust={adjustColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible px-3">
            <SortableHeader label="状态" sortKey="status" sort={sort} onSort={onSort} />
            <ColumnResizeHandle column="status" minimums={minimums} fitted={fitted} width={Math.round(fitted.status)} active={resizingColumn === 'status'} onResize={beginResize} onReset={resetColumn} onAdjust={adjustColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible px-3">
            {transferView ? <span className="ms-auto">速度</span> : <SortableHeader label="大小" sortKey="size" sort={sort} onSort={onSort} align="right" />}
            <ColumnResizeHandle column="size" minimums={minimums} fitted={fitted} width={Math.round(fitted.size)} active={resizingColumn === 'size'} onResize={beginResize} onReset={resetColumn} onAdjust={adjustColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible px-3">
            {transferView ? <span className="ms-auto">剩余时间</span> : <SortableHeader label="时间" sortKey="activity" sort={sort} onSort={onSort} align="right" />}
            <ColumnResizeHandle column="activity" minimums={minimums} fitted={fitted} width={Math.round(fitted.activity)} active={resizingColumn === 'activity'} onResize={beginResize} onReset={resetColumn} onAdjust={adjustColumn} />
          </span>
          <span className="flex h-full min-w-0 items-center px-3">
            <SortableHeader label="进度" sortKey="progress" sort={sort} onSort={onSort} />
          </span>
        </div>
      ) : null}
      <section ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2 scroll-quiet">
        {tasks.length === 0 ? (
          empty
        ) : (
          <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = displayItems[virtualRow.index]
              if (!item) return null
              return (
                <li
                  key={item.kind === 'collection' ? `collection:${item.id}` : `task:${item.task.id}`}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {item.kind === 'collection' ? (
                    <CollectionRow
                            transferView={transferView}
                      collectionID={item.id}
                      tasks={item.tasks}
                      expanded={expandedCollections.has(item.id)}
                      onToggle={() => onToggleCollection(item.id)}
                      columnTemplate={columnTemplate}
                    />
                  ) : (
                    <TaskRow
                      transferView={transferView}
                      task={item.task}
                      coveredColumns={coveredColumns}
                      selected={selectedIds.has(item.task.id) && selectedIds.size === 1}
                      multiSelected={selectedIds.has(item.task.id) && selectedIds.size > 1}
                      justCompleted={celebratingIds.has(item.task.id)}
                      index={visualIndexById.get(item.task.id) ?? 0}
                      onSelect={onSelect}
                      onFileDrag={handleFileDrag}
                      onFileCommand={onFileCommand}
                      onContextMenu={onContextMenu}
                      actionBusy={actionBusyTaskID === item.task.id}
                      actionErrorId={actionErrorId}
                      onToggle={onTaskToggle}
                      onRestart={onTaskRestart}
                      installProgress={installProgress}
                      columnTemplate={columnTemplate}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      </div>
    </div>
  )
}

const COLUMN_LABELS: Record<ColumnKey, string> = {
  filename: '文件名',
  status: '状态',
  size: '大小与速度',
  activity: '时间',
  progress: '进度'
}

function ColumnResizeHandle({
  column,
  minimums,
  fitted,
  width,
  active = false,
  onResize,
  onReset,
  onAdjust
}: {
  column: ColumnKey
  minimums: ColumnWidths
  fitted: ColumnWidths
  width: number
  active?: boolean
  onResize: (column: ColumnKey, event: React.PointerEvent<HTMLSpanElement>) => void
  onReset: (column: ColumnKey) => void
  onAdjust: (column: ColumnKey, delta: number) => void
}) {
  const neighbor = TABLE_KEYS.slice(TABLE_KEYS.indexOf(column) + 1).find(key => fitted[key] > 0)
  const limits = { min: minimums[column], max: fitted[column] + (neighbor ? fitted[neighbor] - minimums[neighbor] : 0) }
  return (
    <span
      role="separator"
      aria-label={`调整${COLUMN_LABELS[column]}列宽`}
      aria-orientation="vertical"
      aria-valuemin={limits.min}
      aria-valuemax={Math.round(limits.max)}
      aria-valuenow={width}
      title="拖动调整列宽 · 方向键微调 · 双击恢复"
      tabIndex={0}
      onPointerDown={(event) => onResize(column, event)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onAdjust(column, event.key === 'ArrowRight' ? 8 : -8)
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset(column)
      }}
      className="group/resize absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-2.5 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 ${
          active ? 'bg-paper/40' : 'bg-transparent group-hover/resize:bg-paper/25 group-focus-visible/resize:bg-paper/35'
        }`}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-7 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-strong bg-panel opacity-0 shadow-sm transition-opacity duration-150 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100"
      />
    </span>
  )
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  compact = false
}: {
  label: string
  sortKey: TaskSortKey
  sort: TaskSort
  onSort: (key: TaskSortKey) => void
  align?: 'left' | 'right'
  compact?: boolean
}) {
  const active = sort.key === sortKey
  const Icon = sort.direction === 'asc' ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      aria-label={`${label}排序`}
      aria-pressed={active}
      title={active ? `${label}：${sort.direction === 'asc' ? '升序' : '降序'}，再次点击切换` : `按${label}排序`}
      onClick={() => onSort(sortKey)}
      className={`group/header relative inline-flex min-w-0 items-center gap-0.5 text-[12px] text-fog transition-colors hover:text-paper ${compact ? 'w-auto shrink-0' : 'w-full'} ${align === 'right' ? 'justify-end text-right' : ''}`}
    >
      <span className="truncate">{label}</span>
      <span className={`pointer-events-none absolute grid size-3 place-items-center ${align === 'right' ? '-right-3' : '-left-3'}`} aria-hidden>
        {active ? <Icon size={12} className="text-mist" strokeWidth={2} /> : null}
      </span>
    </button>
  )
}
