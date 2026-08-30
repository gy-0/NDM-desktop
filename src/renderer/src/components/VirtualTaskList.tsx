import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { buildDisplayItems, visualTasks } from '../lib/taskList'
import type { TaskSort, TaskSortKey } from '../lib/taskList'
import type { Task } from '../lib/types'
import { CollectionRow } from './CollectionRow'
import { TaskRow } from './TaskRow'

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

  const collectionCount = useMemo(
    () => new Set(tasks.flatMap((task) => (task.collection ? [task.collection.id] : []))).size,
    [tasks],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tasks.length > 0 ? (
        <div className="grid h-[34px] shrink-0 grid-cols-[minmax(220px,1fr)_88px_112px_108px_124px] items-center border-b border-line/70 px-7 text-[11px] text-fog">
          <span className="flex min-w-0 items-center gap-2">
            <SortableHeader label="文件名" sortKey="filename" sort={sort} onSort={onSort} />
            <span className="truncate font-mono tabular-nums text-mist">
              {tasks.length} 项{collectionCount > 0 ? ` · ${collectionCount} 个合集` : ''}
            </span>
          </span>
          <SortableHeader label="状态" sortKey="status" sort={sort} onSort={onSort} />
          <SortableHeader label="大小 / 速度" sortKey="size" sort={sort} onSort={onSort} align="right" />
          <SortableHeader label="时间" sortKey="activity" sort={sort} onSort={onSort} align="right" />
          <SortableHeader label="进度" sortKey="progress" sort={sort} onSort={onSort} />
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
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left'
}: {
  label: string
  sortKey: TaskSortKey
  sort: TaskSort
  onSort: (key: TaskSortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === sortKey
  const Icon = active ? (sort.direction === 'asc' ? ChevronUp : ChevronDown) : null
  return (
    <button
      type="button"
      aria-label={`${label}排序`}
      aria-pressed={active}
      title={active ? `${label}：${sort.direction === 'asc' ? '升序' : '降序'}，再次点击切换` : `按${label}排序`}
      onClick={() => onSort(sortKey)}
      className={`group/header inline-flex min-w-0 items-center gap-1 text-[11px] text-fog transition-colors hover:text-paper ${align === 'right' ? 'justify-end pe-4 text-right' : ''}`}
    >
      <span className="truncate">{label}</span>
      {Icon ? <Icon size={12} className="shrink-0 text-copper" strokeWidth={2} /> : null}
    </button>
  )
}
