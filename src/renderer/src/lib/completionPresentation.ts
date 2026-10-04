import type { Task } from './types'

/** The recent-files surface owns visible library completion feedback.
 * A filtered/search view still gets the notice for a completed task outside it. */
export function completionPocketOwnsNotice(notice: { id: number } | null, tasks: Pick<Task, 'id' | 'status'>[], query: string, layout: 'cards' | 'list', heroVisible: boolean): boolean {
  return Boolean(notice && !query.trim() && (layout === 'cards' || !heroVisible)
    && tasks.some(task => task.id === notice.id && task.status === 'complete'))
}
