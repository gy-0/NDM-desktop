import { basename, extname } from 'node:path'

export type WindowsCategory =
  | 'video'
  | 'audio'
  | 'document'
  | 'compressed'
  | 'application'
  | 'image'
  | 'misc'

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function clampConnections(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 8
  return Math.min(16, Math.max(1, Math.round(parsed)))
}

export function sanitizeWindowsFilename(value: string, fallback = '未命名下载'): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
  if (!cleaned || RESERVED_WINDOWS_NAMES.test(cleaned)) return `_${cleaned || fallback}`
  return cleaned
}

export function nameFromDownloadUrl(raw: string, taskId: number): string {
  try {
    const url = new URL(raw)
    if (url.protocol === 'magnet:') {
      return sanitizeWindowsFilename(url.searchParams.get('dn') || `磁力任务-${taskId}`)
    }
    const candidate = decodeURIComponent(basename(url.pathname))
    return sanitizeWindowsFilename(candidate || `下载任务-${taskId}`)
  } catch {
    return `下载任务-${taskId}`
  }
}

export function sourceFromDownloadUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol === 'magnet:') return 'BitTorrent'
    return url.hostname.replace(/^www\./, '') || url.protocol.replace(':', '').toUpperCase()
  } catch {
    return '未知来源'
  }
}

export function categoryForFilename(filename: string): WindowsCategory {
  const extension = extname(filename).slice(1).toLowerCase()
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'flv', 'm3u8'].includes(extension)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'].includes(extension)) return 'audio'
  if (['pdf', 'doc', 'docx', 'txt', 'epub', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx'].includes(extension)) return 'document'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(extension)) return 'compressed'
  if (['exe', 'msi', 'apk', 'appx', 'msix'].includes(extension)) return 'application'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) return 'image'
  return 'misc'
}

export function segmentSnapshot(connections: number, progress: number): Array<{ id: number; fraction: number }> {
  const count = clampConnections(connections)
  const fraction = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
  return Array.from({ length: count }, (_, id) => ({ id, fraction }))
}

export function ownedTaskArtifactNames(filename: string, includeFinal: boolean): string[] {
  const names = [
    `${filename}.aria2`,
    `${filename}.part`,
    `${filename}.ytdl`
  ]
  if (includeFinal) names.unshift(filename)
  return names
}

export function isSupportedDownloadUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'ftp:' || protocol === 'magnet:'
  } catch {
    return false
  }
}
