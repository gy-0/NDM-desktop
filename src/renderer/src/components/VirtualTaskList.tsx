import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, type ReactNode } from 'react'
import type { Task } from '../lib/types'
import { TaskRow } from './TaskRow'

export function VirtualTaskList({
  tasks,
  selectedIds,
  celebratingIds,
  empty,
  onSelect,
  onContextMenu
}: {
  tasks: Task[]
  selectedIds: Set<number>
  celebratingIds: Set<number>
  empty: ReactNode
  onSelect: (event: React.MouseEvent, task: Task, index: number) => void
  onContextMenu: (event: React.MouseEvent, task: Task) => void
}) {
  const scrollRef = useRef<HTMLElement>(null)
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    getItemKey: (index) => tasks[index]?.id ?? index,
    gap: 6,
    overscan: 8
  })

  const singleSelectedId = selectedIds.size === 1 ? selectedIds.values().next().value : undefined
  const selectedIndex = singleSelectedId === undefined ? -1 : tasks.findIndex((task) => task.id === singleSelectedId)

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedIndex, virtualizer])

  return (
    <section ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-quiet">
      {tasks.length === 0 ? (
        empty
      ) : (
        <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const task = tasks[virtualRow.index]
            return (
              <li
                key={task.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TaskRow
                  task={task}
                  selected={selectedIds.has(task.id) && selectedIds.size === 1}
                  multiSelected={selectedIds.has(task.id) && selectedIds.size > 1}
                  justCompleted={celebratingIds.has(task.id)}
                  index={virtualRow.index}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
