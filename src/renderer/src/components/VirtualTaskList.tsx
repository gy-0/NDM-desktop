import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Task } from '../lib/types'
import { CollectionRow } from './CollectionRow'
import { TaskRow } from './TaskRow'

type DisplayItem =
  | { kind: 'task'; task: Task; sourceIndex: number; collectionChild: boolean }
  | { kind: 'collection'; id: string; tasks: Task[] }

export function VirtualTaskList({
  tasks,
  allTasks,
  selectedIds,
  celebratingIds,
  empty,
  onSelect,
  onContextMenu
}: {
  tasks: Task[]
  allTasks: Task[]
  selectedIds: Set<number>
  celebratingIds: Set<number>
  empty: ReactNode
  onSelect: (event: React.MouseEvent, task: Task, index: number) => void
  onContextMenu: (event: React.MouseEvent, task: Task) => void
}) {
  const scrollRef = useRef<HTMLElement>(null)
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set())
  const sourceIndexes = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks])
  const allCollections = useMemo(() => {
    const groups = new Map<string, Task[]>()
    for (const task of allTasks) {
      if (!task.collection?.id) continue
      const group = groups.get(task.collection.id) ?? []
      group.push(task)
      groups.set(task.collection.id, group)
    }
    return groups
  }, [allTasks])
  const displayItems = useMemo(() => {
    const items: DisplayItem[] = []
    const handled = new Set<string>()
    for (const task of tasks) {
      const collectionID = task.collection?.id
      if (!collectionID) {
        items.push({ kind: 'task', task, sourceIndex: sourceIndexes.get(task.id) ?? 0, collectionChild: false })
        continue
      }
      if (handled.has(collectionID)) continue
      handled.add(collectionID)
      const visibleTasks = tasks
        .filter((candidate) => candidate.collection?.id === collectionID)
        .sort((a, b) => (a.collection?.index ?? a.id) - (b.collection?.index ?? b.id))
      items.push({
        kind: 'collection',
        id: collectionID,
        tasks: allCollections.get(collectionID) ?? visibleTasks
      })
      if (expandedCollections.has(collectionID)) {
        for (const child of visibleTasks) {
          items.push({ kind: 'task', task: child, sourceIndex: sourceIndexes.get(child.id) ?? 0, collectionChild: true })
        }
      }
    }
    return items
  }, [allCollections, expandedCollections, sourceIndexes, tasks])

  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => displayItems[index]?.kind === 'collection' ? 68 : 62,
    getItemKey: (index) => {
      const item = displayItems[index]
      return item?.kind === 'collection' ? `collection:${item.id}` : `task:${item?.task.id ?? index}`
    },
    gap: 6,
    overscan: 8
  })

  const singleSelectedId = selectedIds.size === 1 ? selectedIds.values().next().value : undefined
  const selectedTask = singleSelectedId === undefined ? undefined : allTasks.find((task) => task.id === singleSelectedId)

  useEffect(() => {
    const collectionID = selectedTask?.collection?.id
    if (!collectionID || expandedCollections.has(collectionID)) return
    setExpandedCollections((current) => new Set([...current, collectionID]))
  }, [expandedCollections, selectedTask?.collection?.id])

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
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line/55 px-5 text-[10.5px] text-mist">
          <span className="font-medium tracking-[0.04em] text-fog">任务</span>
          <span className="font-mono tabular-nums">
            {tasks.length} 项{collectionCount > 0 ? ` · ${collectionCount} 个合集` : ''} · 最近活动优先
          </span>
        </div>
      ) : null}
      <section ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5 scroll-quiet">
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
                  className={`absolute left-0 top-0 w-full ${item.kind === 'task' && item.collectionChild ? 'ps-3' : ''}`}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {item.kind === 'collection' ? (
                    <CollectionRow
                      collectionID={item.id}
                      tasks={item.tasks}
                      expanded={expandedCollections.has(item.id)}
                      onToggle={() => {
                        setExpandedCollections((current) => {
                          const next = new Set(current)
                          if (next.has(item.id)) next.delete(item.id)
                          else next.add(item.id)
                          return next
                        })
                      }}
                    />
                  ) : (
                    <TaskRow
                      task={item.task}
                      selected={selectedIds.has(item.task.id) && selectedIds.size === 1}
                      multiSelected={selectedIds.has(item.task.id) && selectedIds.size > 1}
                      justCompleted={celebratingIds.has(item.task.id)}
                      index={item.sourceIndex}
                      onSelect={onSelect}
                      onContextMenu={onContextMenu}
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
