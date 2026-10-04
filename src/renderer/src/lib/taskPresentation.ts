import type { Task } from './types'

/** Human-readable failure copy is shared by list, cards and details.
 * Diagnostic tokens are protocol values; never expose them as user guidance. */
export function taskFailureSummary(task: Pick<Task, 'status' | 'diagnostic' | 'errorText'>): string | undefined {
  if (task.status !== 'error') return undefined
  const diagnostic = task.diagnostic?.summary?.trim() || task.diagnostic?.title?.trim()
  if (diagnostic?.trim()) return diagnostic.trim()
  const error = task.errorText?.trim()
  if (error && !error.startsWith('#diag:')) return error.replace(/\s+/g, ' ')
  return '下载未完成，请查看详情恢复。'
}
