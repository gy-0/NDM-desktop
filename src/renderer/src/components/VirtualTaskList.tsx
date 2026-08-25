import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { buildDisplayItems, visualTasks } from '../lib/taskList'
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
  onTaskRestart
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
        <div className="grid h-[34px] shrink-0 grid-cols-[minmax(250px,1fr)_88px_112px_124px] items-center border-b border-line/70 px-7 text-[11px] text-fog">
          <span className="flex min-w-0 items-center gap-2">
            <span>文件名</span>
            <span className="truncate font-mono tabular-nums text-mist">
              {tasks.length} 项{collectionCount > 0 ? ` · ${collectionCount} 个合集` : ''}
            </span>
          </span>
          <span>状态</span>
          <span>大小 / 速度</span>
          <span>进度</span>
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
