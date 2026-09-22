import type { Task } from './types'

export function needsChangedResourceRedownload(task: Pick<Task, 'status' | 'errorText' | 'canRedownloadChangedResource'>): boolean {
  return task.status === 'error' && task.canRedownloadChangedResource === true && task.errorText === '#diag:downloadRecordChanged'
}

export function needsSourceRecovery(task: Pick<Task, 'status' | 'diagnostic' | 'errorText' | 'canRedownloadChangedResource'>): boolean {
  return needsChangedResourceRedownload(task) || task.status === 'error' && ['renew', 'openPage'].includes(task.diagnostic?.primaryAction ?? '')
}

export function needsInteractiveRecovery(task: Pick<Task, 'status' | 'diagnostic' | 'errorText' | 'canRedownloadChangedResource' | 'linkType'>): boolean {
  return needsSourceRecovery(task) && (task.linkType !== 'ytdlp' || task.diagnostic?.primaryAction === 'openPage')
}

export function recoveryPage(task: Pick<Task, 'pageURL' | 'url' | 'linkType'>): string | null {
  const value = task.pageURL || (task.linkType === 'ytdlp' ? task.url : '')
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function taskRecoveryMessage(task: Pick<Task, 'status' | 'diagnostic' | 'pageURL' | 'url' | 'linkType' | 'errorText' | 'canRedownloadChangedResource'>): string | undefined {
  if (needsChangedResourceRedownload(task)) return '源文件或下载记录已变化，不能安全续传。可确认重新下载；原任务和旧进度会保留，新内容从头下载。'
  if (!needsSourceRecovery(task)) return task.diagnostic?.message
  if (task.errorText === '#diag:unexpectedWebPage') return recoveryPage(task)
    ? '服务器返回了网页，尚未取得所需文件。请在来源网页确认可以下载，按需登录后重新获取。'
    : '服务器返回了网页，尚未取得所需文件。此任务没有保存来源网页，请回到原网页重新发起下载。'
  if (task.linkType === 'ytdlp') return '重新读取原页面后继续下载。需要登录时，请在原浏览器账号中完成登录。'
  if (recoveryPage(task)) return '重新获取原页面中的文件或视频，无需查找下载直链。'
  return '这个任务没有保存来源网页。请回到原网页重新发起下载，原有进度会保留。'
}
