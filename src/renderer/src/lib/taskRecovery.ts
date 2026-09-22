import type { Task } from './types'

export function needsSourceRecovery(task: Pick<Task, 'status' | 'diagnostic'>): boolean {
  return task.status === 'error' && ['renew', 'openPage'].includes(task.diagnostic?.primaryAction ?? '')
}

export function recoveryPage(task: Pick<Task, 'pageURL' | 'url' | 'linkType'>): string | null {
  const value = task.pageURL || (task.linkType === 'ytdlp' ? task.url : '')
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function taskRecoveryMessage(task: Pick<Task, 'status' | 'diagnostic' | 'pageURL' | 'url' | 'linkType'>): string | undefined {
  if (!needsSourceRecovery(task)) return task.diagnostic?.message
  if (task.linkType === 'ytdlp') return '重新读取原页面后继续下载。需要登录时，请在原浏览器账号中完成登录。'
  if (recoveryPage(task)) return '重新获取原页面中的文件或视频，无需查找下载直链。'
  return '这个任务没有保存来源网页。请回到原网页重新发起下载，原有进度会保留。'
}
