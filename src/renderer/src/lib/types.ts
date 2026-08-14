export type DownloadStatus =
  | 'downloading'
  | 'paused'
  | 'waiting'
  | 'complete'
  | 'error'
  | 'incomplete'

export type DownloadCategory =
  | 'video'
  | 'audio'
  | 'document'
  | 'compressed'
  | 'application'
  | 'image'
  | 'misc'

export type DownloadPhase =
  | 'preparing'
  | 'transferring'
  | 'merging'
  | 'subtitles'
  | 'finalizing'

export type FilterId =
  | 'all'
  | 'active'
  | 'queued'
  | 'paused'
  | 'completed'
  | 'failed'
  | DownloadCategory

export interface Segment {
  id: number
  fraction: number
}

export interface Task {
  id: number
  filename: string
  title: string
  url: string
  source?: string
  category: DownloadCategory
  status: DownloadStatus
  phase?: DownloadPhase
  fileSize: number
  completedBytes: number
  bytesPerSecond: number
  connections: number
  segments: Segment[]
  errorText?: string
  completedAt?: number
  folderPath: string
}

export const CATEGORY_LABEL: Record<DownloadCategory, string> = {
  video: '视频',
  audio: '音频',
  document: '文档',
  compressed: '压缩包',
  application: '应用',
  image: '图片',
  misc: '其他'
}

export const STATUS_LABEL: Record<DownloadStatus, string> = {
  downloading: '正在下载',
  paused: '已暂停',
  waiting: '等待中',
  complete: '已完成',
  error: '失败',
  incomplete: '未完成'
}

export const PHASE_LABEL: Record<DownloadPhase, string> = {
  preparing: '正在解析',
  transferring: '正在下载',
  merging: '正在合并',
  subtitles: '正在处理字幕',
  finalizing: '即将完成'
}
