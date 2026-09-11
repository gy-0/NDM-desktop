import type { Task } from './types'

export function completedDragPaths(task: Task, tasks: Task[], selection: ReadonlySet<number>): string[] {
  if (task.status !== 'complete') return []
  const dragged = selection.has(task.id) ? tasks.filter(item => selection.has(item.id)) : [task]
  return [...new Set(dragged.filter(item => item.status === 'complete' && item.folderPath && item.filename)
    .map(item => `${item.folderPath.replace(/[\\/]$/, '')}/${item.filename}`))]
}
