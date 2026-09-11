import type { Task } from './types'

export function historyTaskIDs(tasks: Pick<Task, 'id' | 'status'>[], selection: { completed: boolean; failed: boolean }): number[] {
  return tasks.filter(task => (selection.completed && task.status === 'complete') || (selection.failed && task.status === 'error')).map(task => task.id)
}

export function historyClearError(failure: unknown): string {
  const partial = failure instanceof Error ? failure.message.match(/只删除了 (\d+)\/(\d+)/) : null
  return partial
    ? `已清除 ${partial[1]} 条记录，其余 ${Number(partial[2]) - Number(partial[1])} 条未能清除。请重试。`
    : '未能清除下载记录。请重试。'
}
