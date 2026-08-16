import type { Task } from './types'

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
