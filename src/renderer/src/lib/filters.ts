import { CATEGORY_LABEL, type FilterId } from './types'

export const STATUS_FILTERS: { id: FilterId; label: string; mark: string }[] = [
  { id: 'all', label: '全部', mark: '全' },
  { id: 'active', label: '下载中', mark: '下' },
  { id: 'queued', label: '等待中', mark: '等' },
  { id: 'paused', label: '已暂停', mark: '停' },
  { id: 'completed', label: '已完成', mark: '完' },
  { id: 'failed', label: '失败', mark: '败' }
]

export const TYPE_FILTERS: { id: FilterId; label: string; mark: string }[] = (
  ['video', 'audio', 'document', 'compressed', 'application', 'image'] as const
).map((id) => ({
  id,
  label: CATEGORY_LABEL[id],
  mark: { video: '影', audio: '声', document: '文', compressed: '包', application: '用', image: '图' }[id]
}))
