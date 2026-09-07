import type { FilterId, Task } from './types'

export const WORKSPACE_LABELS: Record<FilterId, string> = {
  all: '全部下载', active: '下载中', queued: '等待中', paused: '已暂停',
  completed: '已完成', failed: '失败任务', video: '视频', audio: '音频',
  document: '文档', compressed: '压缩包', application: '应用', image: '图片', misc: '其他'
}

function searchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** All words must match, but they may occur in different task fields. */
export function filterLibraryTasks(tasks: readonly Task[], filter: FilterId, query: string): Task[] {
  const words = searchText(query).trim().split(/\s+/u).filter(Boolean)
  return tasks.filter((task) => {
    const matches = filter === 'all' || task.category === filter ||
      (filter === 'active' && task.status === 'downloading') ||
      (filter === 'queued' && task.status === 'waiting') ||
      (filter === 'paused' && (task.status === 'paused' || task.status === 'incomplete')) ||
      (filter === 'completed' && task.status === 'complete') ||
      (filter === 'failed' && task.status === 'error')
    if (!matches) return false
    if (!words.length) return true
    const fields = [task.filename, task.title, task.source, task.url, task.pageURL, task.collection?.title]
      .filter((value): value is string => Boolean(value)).map(searchText)
    return words.every((word) => fields.some((field) => field.includes(word)))
  })
}

/** Search is a results list, not a dashboard. Never remove a row for a hidden Hero. */
export function workspaceHero(tasks: readonly Task[], filter: FilterId, query: string, spotlightId: number | null): Task | undefined {
  if (query.trim() || ['completed', 'failed', 'paused', 'queued'].includes(filter)) return undefined
  return tasks.find((task) => task.id === spotlightId &&
    (task.status === 'downloading' || task.status === 'paused' || task.status === 'incomplete')) ??
    tasks.find((task) => task.status === 'downloading')
}

export function selectionRange(ids: readonly number[], anchorId: number | null, targetId: number): Set<number> {
  const target = ids.indexOf(targetId)
  if (target < 0) return new Set()
  const anchor = anchorId === null ? -1 : ids.indexOf(anchorId)
  if (anchor < 0) return new Set([targetId])
  return new Set(ids.slice(Math.min(anchor, target), Math.max(anchor, target) + 1))
}

/** The anchor stays fixed while the focus moves, allowing Shift to grow AND shrink a range. */
export function moveSelection(ids: readonly number[], anchorId: number | null, focusId: number | null, direction: 1 | -1, extend: boolean) {
  if (!ids.length) return { selected: new Set<number>(), anchorId: null, focusId: null }
  const current = focusId === null ? -1 : ids.indexOf(focusId)
  const index = current < 0 ? (direction === 1 ? 0 : ids.length - 1)
    : Math.max(0, Math.min(ids.length - 1, current + direction))
  const nextId = ids[index]
  const anchor = extend && anchorId !== null && ids.includes(anchorId) ? anchorId : nextId
  return { selected: extend ? selectionRange(ids, anchor, nextId) : new Set([nextId]), anchorId: anchor, focusId: nextId }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable ||
    Boolean(target.closest('input, textarea, select, [role="textbox"]')))
}
