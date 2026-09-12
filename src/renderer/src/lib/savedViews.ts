import type { DownloadCategory, FilterId, Task } from './types'
import { DEFAULT_TASK_SORT, type TaskSort } from './taskList'
import { filterLibraryTasks, WORKSPACE_LABELS } from './workspace'

export type ViewStatus = 'all' | 'active' | 'queued' | 'paused' | 'completed' | 'failed'
export type ViewTime = 'any' | 'today' | 'week' | 'month'
export type LibraryViewCriteria = { status: ViewStatus; type: 'all' | DownloadCategory; query: string; time: ViewTime }
export type SavedView = { id: string; name: string; criteria: LibraryViewCriteria; sort: TaskSort; createdAt: number; updatedAt: number }
export type SavedViewMutationResult = { ok: true; id: string } | { ok: false; error: string }
type SavedViewsChange = { ok: true; id: string; views: SavedView[] } | { ok: false; error: string }

export const SAVED_VIEWS_KEY = 'ndm-saved-views-v1'
export const DEFAULT_VIEW_CRITERIA: LibraryViewCriteria = { status: 'all', type: 'all', query: '', time: 'any' }
export const VIEW_STATUS_OPTIONS: { value: ViewStatus; label: string }[] = [
  { value: 'all', label: '所有状态' }, { value: 'active', label: '下载中' }, { value: 'queued', label: '等待中' },
  { value: 'paused', label: '已暂停' }, { value: 'completed', label: '已完成' }, { value: 'failed', label: '失败' }
]
export const VIEW_TYPE_OPTIONS: { value: LibraryViewCriteria['type']; label: string }[] = [
  { value: 'all', label: '所有类型' }, { value: 'video', label: '视频' }, { value: 'audio', label: '音频' },
  { value: 'document', label: '文档' }, { value: 'compressed', label: '压缩包' }, { value: 'application', label: '应用' },
  { value: 'image', label: '图片' }, { value: 'misc', label: '其他' }
]
export const VIEW_TIME_OPTIONS: { value: ViewTime; label: string }[] = [
  { value: 'any', label: '不限时间' }, { value: 'today', label: '今天' },
  { value: 'week', label: '最近 7 天' }, { value: 'month', label: '最近 30 天' }
]

export function criteriaFromFilter(filter: FilterId, query = ''): LibraryViewCriteria {
  return criteriaWithSidebarFilter({ ...DEFAULT_VIEW_CRITERIA, query }, filter, true)
}

/** Sidebar dimensions remain visible together; All deliberately clears every condition. */
export function criteriaWithSidebarFilter(current: LibraryViewCriteria, filter: FilterId, preserveAllQuery = false): LibraryViewCriteria {
  if (filter === 'all') return { ...DEFAULT_VIEW_CRITERIA, query: preserveAllQuery ? current.query : '' }
  if (VIEW_STATUS_OPTIONS.some(option => option.value === filter)) return { ...current, status: filter as ViewStatus }
  return { ...current, type: filter as DownloadCategory }
}

/** Legacy Hero/EmptyState compatibility only. The visible title should describe all conditions. */
export function primaryFilterForView(criteria: LibraryViewCriteria): FilterId {
  return criteria.status !== 'all' ? criteria.status : criteria.type !== 'all' ? criteria.type : 'all'
}

export function activityWindowStart(time: ViewTime, now: number): number | null {
  if (time === 'any') return null
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (time === 'week') start.setDate(start.getDate() - 6)
  if (time === 'month') start.setDate(start.getDate() - 29)
  return start.getTime()
}

/** Activity windows use local calendar days, including today, and exclude unknown dates. */
export function filterTasksForView(tasks: readonly Task[], criteria: LibraryViewCriteria, now = Date.now()): Task[] {
  const byStatus = filterLibraryTasks(tasks, criteria.status, criteria.query)
  const byType = criteria.type === 'all' ? byStatus : byStatus.filter(task => task.category === criteria.type)
  const start = activityWindowStart(criteria.time, now)
  if (start === null) return byType
  return byType.filter(task => Number.isFinite(task.activityAt) && task.activityAt! >= start && task.activityAt! <= now)
}

export function viewCriteriaSummary(criteria: LibraryViewCriteria, includeQuery = true): string {
  const parts: string[] = []
  if (criteria.status !== 'all') parts.push(WORKSPACE_LABELS[criteria.status])
  if (criteria.type !== 'all') parts.push(WORKSPACE_LABELS[criteria.type])
  if (criteria.time !== 'any') parts.push(`最近活动：${VIEW_TIME_OPTIONS.find(option => option.value === criteria.time)?.label}`)
  if (includeQuery && criteria.query.trim()) parts.push(`“${criteria.query.trim()}”`)
  return parts.join(' · ') || '全部下载'
}

export function viewSortSummary(sort: TaskSort): string {
  if (sort.key === 'activity') return sort.direction === 'desc' ? '最近活动优先' : '较早活动优先'
  if (sort.key === 'filename') return sort.direction === 'asc' ? '文件名 A → Z' : '文件名 Z → A'
  if (sort.key === 'size') return sort.direction === 'desc' ? '大文件优先' : '小文件优先'
  if (sort.key === 'progress') return sort.direction === 'desc' ? '进度从高到低' : '进度从低到高'
  return sort.direction === 'asc' ? '按状态排列' : '按状态倒序'
}

function normalizedQuery(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() }
function normalizedName(value: string): string { return value.normalize('NFKC').trim().toLowerCase() }

export function savedViewMatches(view: SavedView, criteria: LibraryViewCriteria, sort: TaskSort): boolean {
  return view.criteria.status === criteria.status && view.criteria.type === criteria.type && view.criteria.time === criteria.time &&
    normalizedQuery(view.criteria.query) === normalizedQuery(criteria.query) && view.sort.key === sort.key && view.sort.direction === sort.direction
}

function validCriteria(value: unknown): value is LibraryViewCriteria {
  if (!value || typeof value !== 'object') return false
  const c = value as LibraryViewCriteria
  return VIEW_STATUS_OPTIONS.some(option => option.value === c.status) && VIEW_TYPE_OPTIONS.some(option => option.value === c.type) &&
    VIEW_TIME_OPTIONS.some(option => option.value === c.time) && typeof c.query === 'string' && c.query.length <= 4096
}

function validSort(value: unknown): value is TaskSort {
  if (!value || typeof value !== 'object') return false
  const s = value as TaskSort
  return ['filename', 'status', 'size', 'activity', 'progress'].includes(s.key) && ['asc', 'desc'].includes(s.direction)
}

function validName(name: string): string | null {
  if (!name.trim()) return '请为视图起个名字。'
  if (Array.from(name.trim()).length > 40) return '名称最多 40 个字。'
  return null
}

export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; views?: unknown[] }
    if (parsed?.version !== 1 || !Array.isArray(parsed.views)) return []
    const ids = new Set<string>()
    const names = new Set<string>()
    return parsed.views.slice(0, 100).flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const view = value as SavedView
      if (typeof view.id !== 'string' || !view.id || view.id.length > 100 || typeof view.name !== 'string' || validName(view.name) ||
        !validCriteria(view.criteria) || !Number.isFinite(view.createdAt) || !Number.isFinite(view.updatedAt) ||
        ids.has(view.id) || names.has(normalizedName(view.name))) return []
      ids.add(view.id)
      names.add(normalizedName(view.name))
      return [{ id: view.id, name: view.name.trim(), criteria: { ...view.criteria }, sort: validSort(view.sort) ? { ...view.sort } : { ...DEFAULT_TASK_SORT }, createdAt: view.createdAt, updatedAt: view.updatedAt }]
    })
  } catch { return [] }
}

export function serializeSavedViews(views: readonly SavedView[]): string {
  return JSON.stringify({ version: 1, views })
}

export function addSavedView(views: readonly SavedView[], name: string, criteria: LibraryViewCriteria, sort: TaskSort, id = crypto.randomUUID(), now = Date.now()): SavedViewsChange {
  const error = validName(name)
  if (error) return { ok: false, error }
  if (views.some(view => normalizedName(view.name) === normalizedName(name))) return { ok: false, error: '已有同名视图，请换一个名字。' }
  if (views.length >= 100) return { ok: false, error: '常用视图已满，请先移除不再使用的视图。' }
  if (!validCriteria(criteria) || !validSort(sort)) return { ok: false, error: '筛选条件无效，请重新选择。' }
  return { ok: true, id, views: [...views, { id, name: name.trim(), criteria: { ...criteria, query: criteria.query.trim() }, sort: { ...sort }, createdAt: now, updatedAt: now }] }
}

export function renameSavedView(views: readonly SavedView[], id: string, name: string, now = Date.now()): SavedViewsChange {
  if (!views.some(view => view.id === id)) return { ok: false, error: '这个视图已被移除。' }
  const error = validName(name)
  if (error) return { ok: false, error }
  if (views.some(view => view.id !== id && normalizedName(view.name) === normalizedName(name))) return { ok: false, error: '已有同名视图，请换一个名字。' }
  return { ok: true, id, views: views.map(view => view.id === id ? { ...view, name: name.trim(), updatedAt: now } : view) }
}

export function removeSavedView(views: readonly SavedView[], id: string): SavedViewsChange {
  if (!views.some(view => view.id === id)) return { ok: false, error: '这个视图已被移除。' }
  return { ok: true, id, views: views.filter(view => view.id !== id) }
}
