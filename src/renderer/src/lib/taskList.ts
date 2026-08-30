import { fractionOf } from './format'
import type { Task } from './types'

export type TaskSortKey = 'filename' | 'status' | 'size' | 'activity' | 'progress'
export type TaskSortDirection = 'asc' | 'desc'
export type TaskSort = { key: TaskSortKey; direction: TaskSortDirection }

export const DEFAULT_TASK_SORT: TaskSort = { key: 'activity', direction: 'desc' }
const TASK_SORT_STORAGE_KEY = 'ndm-task-sort'

export function readTaskSort(): TaskSort {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_SORT_STORAGE_KEY) ?? '') as Partial<TaskSort>
    if (
      (stored.key === 'filename' || stored.key === 'status' || stored.key === 'size' || stored.key === 'activity' || stored.key === 'progress') &&
      (stored.direction === 'asc' || stored.direction === 'desc')
    ) {
      return { key: stored.key, direction: stored.direction }
    }
  } catch {
    // A malformed preference should never prevent the task list from opening.
  }
  return DEFAULT_TASK_SORT
}

export function writeTaskSort(sort: TaskSort): void {
  try {
    localStorage.setItem(TASK_SORT_STORAGE_KEY, JSON.stringify(sort))
  } catch {
    // The current session still keeps the selected order when storage is unavailable.
  }
}

const STATUS_ORDER: Record<Task['status'], number> = {
  downloading: 0,
  waiting: 1,
  paused: 2,
  incomplete: 3,
  error: 4,
  complete: 5
}

function sortValue(task: Task, key: TaskSortKey): string | number {
  if (key === 'filename') return (task.filename || task.title).toLocaleLowerCase()
  if (key === 'status') return STATUS_ORDER[task.status]
  if (key === 'size') return task.fileSize > 0 ? task.fileSize : task.completedBytes
  if (key === 'progress') return fractionOf(task)
  return task.activityAt ?? 0
}

export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const a = sortValue(left.task, sort.key)
      const b = sortValue(right.task, sort.key)
      const primary = typeof a === 'string' && typeof b === 'string'
        ? a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
        : Number(a) - Number(b)
      if (primary !== 0) return primary * direction
      const idTie = right.task.id - left.task.id
      return idTie !== 0 ? idTie : left.index - right.index
    })
    .map(({ task }) => task)
}

export type DisplayItem =
  | { kind: 'task'; task: Task; sourceIndex: number; collectionChild: boolean }
  | { kind: 'collection'; id: string; tasks: Task[] }

export function buildDisplayItems(
  tasks: Task[],
  allTasks: Task[],
  expandedCollections: Set<string>
): DisplayItem[] {
  const sourceIndexes = new Map(tasks.map((task, index) => [task.id, index]))
  const allCollections = new Map<string, Task[]>()
  for (const task of allTasks) {
    const collectionID = task.collection?.id
    if (!collectionID) continue
    const group = allCollections.get(collectionID) ?? []
    group.push(task)
    allCollections.set(collectionID, group)
  }

  const items: DisplayItem[] = []
  const handled = new Set<string>()
  for (const task of tasks) {
    const collectionID = task.collection?.id
    if (!collectionID) {
      items.push({
        kind: 'task',
        task,
        sourceIndex: sourceIndexes.get(task.id) ?? 0,
        collectionChild: false
      })
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
        items.push({
          kind: 'task',
          task: child,
          sourceIndex: sourceIndexes.get(child.id) ?? 0,
          collectionChild: true
        })
      }
    }
  }
  return items
}

export function visualTasks(items: DisplayItem[]): Task[] {
  return items.flatMap((item) => (item.kind === 'task' ? [item.task] : []))
}
