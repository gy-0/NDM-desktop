import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildDisplayItems, visualTasks } from '../lib/taskList'
import type { TaskSort, TaskSortKey } from '../lib/taskList'
import type { Task } from '../lib/types'
import { CollectionRow } from './CollectionRow'
import { TaskRow } from './TaskRow'

type ColumnKey = 'filename' | 'status' | 'size' | 'activity' | 'progress'
type ColumnWidths = Record<ColumnKey, number>

const COLUMN_WIDTHS_KEY = 'ndm-task-column-widths-v2'
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  filename: 480,
  status: 96,
  size: 124,
  activity: 118,
  progress: 150
}
const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  filename: { min: 280, max: 760 },
  status: { min: 82, max: 160 },
  size: { min: 104, max: 180 },
  activity: { min: 102, max: 190 },
  progress: { min: 128, max: 220 }
}

function readColumnWidths(): ColumnWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}') as Partial<ColumnWidths>
    return Object.fromEntries(
      (Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnKey[]).map((key) => {
        const limits = COLUMN_LIMITS[key]
        const value = Number(stored[key] ?? DEFAULT_COLUMN_WIDTHS[key])
        return [key, Math.min(limits.max, Math.max(limits.min, value))]
      })
    ) as ColumnWidths
  } catch {
    return DEFAULT_COLUMN_WIDTHS
  }
}

export function VirtualTaskList({
  tasks,
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
  onTaskRestart,
  sort,
  onSort
}: {
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
  onTaskToggle: (task: Task) => void
  onTaskRestart: (task: Task) => void
  sort: TaskSort
  onSort: (key: TaskSortKey) => void
}) {
  const scrollRef = useRef<HTMLElement>(null)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(readColumnWidths)
  const [resizingColumn, setResizingColumn] = useState<ColumnKey | null>(null)
  const columnTemplate = [
    `minmax(176px, ${columnWidths.filename}px)`,
    `minmax(72px, ${columnWidths.status}px)`,
    `minmax(88px, ${columnWidths.size}px)`,
    `minmax(80px, ${columnWidths.activity}px)`,
    `minmax(${columnWidths.progress}px, 1fr)`
  ].join(' ')
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
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths))
  }, [columnWidths])

  const beginResize = (key: ColumnKey, event: React.PointerEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = columnWidths[key]
    const limits = COLUMN_LIMITS[key]
    setResizingColumn(key)
    document.documentElement.dataset.resizingColumns = 'true'

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(limits.max, Math.max(limits.min, startWidth + moveEvent.clientX - startX))
      setColumnWidths((current) => current[key] === nextWidth ? current : { ...current, [key]: nextWidth })
    }
    const finish = (): void => {
      setResizingColumn(null)
      delete document.documentElement.dataset.resizingColumns
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resetColumn = (key: ColumnKey): void => {
    setColumnWidths((current) => ({ ...current, [key]: DEFAULT_COLUMN_WIDTHS[key] }))
  }

  const collectionCount = useMemo(
    () => new Set(tasks.flatMap((task) => (task.collection ? [task.collection.id] : []))).size,
    [tasks],
  )

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-x-auto scroll-quiet">
      <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
      {tasks.length > 0 ? (
        <div className="mx-4 grid h-9 shrink-0 items-stretch overflow-visible border-b border-line/70 text-[12px] text-fog" style={{ gridTemplateColumns: columnTemplate }}>
          <span className="relative flex h-full min-w-0 items-center gap-2 overflow-visible px-3 pe-5">
            <SortableHeader label="文件名" sortKey="filename" sort={sort} onSort={onSort} compact />
            <span className="truncate font-mono tabular-nums text-mist">
              {tasks.length} 项{collectionCount > 0 ? ` · ${collectionCount} 个合集` : ''}
            </span>
            <ColumnResizeHandle column="filename" active={resizingColumn === 'filename'} onResize={beginResize} onReset={resetColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible">
            <SortableHeader label="状态" sortKey="status" sort={sort} onSort={onSort} />
            <ColumnResizeHandle column="status" active={resizingColumn === 'status'} onResize={beginResize} onReset={resetColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible pe-5">
            <SortableHeader label="大小 / 速度" sortKey="size" sort={sort} onSort={onSort} align="right" />
            <ColumnResizeHandle column="size" active={resizingColumn === 'size'} onResize={beginResize} onReset={resetColumn} />
          </span>
          <span className="relative flex h-full min-w-0 items-center overflow-visible pe-4">
            <SortableHeader label="时间" sortKey="activity" sort={sort} onSort={onSort} align="right" />
            <ColumnResizeHandle column="activity" active={resizingColumn === 'activity'} onResize={beginResize} onReset={resetColumn} />
          </span>
          <span className="flex h-full min-w-0 items-center pe-4">
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
                      collectionID={item.id}
                      tasks={item.tasks}
                      expanded={expandedCollections.has(item.id)}
                      onToggle={() => onToggleCollection(item.id)}
                      columnTemplate={columnTemplate}
                    />
                  ) : (
                    <TaskRow
                      task={item.task}
                      selected={selectedIds.has(item.task.id) && selectedIds.size === 1}
                      multiSelected={selectedIds.has(item.task.id) && selectedIds.size > 1}
                      justCompleted={celebratingIds.has(item.task.id)}
                      index={visualIndexById.get(item.task.id) ?? 0}
                      onSelect={onSelect}
                      onContextMenu={onContextMenu}
                      actionBusy={actionBusyTaskID === item.task.id}
                      actionErrorId={actionErrorId}
                      onToggle={onTaskToggle}
                      onRestart={onTaskRestart}
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

function ColumnResizeHandle({
  column,
  active = false,
  onResize,
  onReset
}: {
  column: ColumnKey
  active?: boolean
  onResize: (column: ColumnKey, event: React.PointerEvent<HTMLSpanElement>) => void
  onReset: (column: ColumnKey) => void
}) {
  return (
    <span
      role="separator"
      aria-label="调整列宽"
      aria-orientation="vertical"
      title="拖动调整列宽 · 双击恢复"
      onPointerDown={(event) => onResize(column, event)}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset(column)
      }}
      className="group/resize absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none"
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
          active ? 'bg-paper/40' : 'bg-transparent group-hover/resize:bg-paper/28'
        }`}
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
      className={`group/header inline-flex min-w-0 items-center gap-0.5 text-[12px] text-fog transition-colors hover:text-paper ${compact ? 'w-auto shrink-0' : 'w-full'} ${align === 'right' ? 'justify-end text-right' : ''}`}
    >
      <span className="truncate">{label}</span>
      <span className="grid size-3 shrink-0 place-items-center" aria-hidden>
        {active ? <Icon size={12} className="text-mist" strokeWidth={2} /> : null}
      </span>
    </button>
  )
}
