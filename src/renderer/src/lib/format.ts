export function formatBytes(bytes: number, digits = 1): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  const rounded = i === 0 ? String(bytes) : value.toFixed(value >= 100 ? 0 : digits)
  return `${rounded} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number): { value: string; unit: string } {
  if (bytesPerSecond <= 0) return { value: '0', unit: 'KB/s' }
  const kb = bytesPerSecond / 1024
  if (kb < 1024) return { value: kb < 10 ? kb.toFixed(1) : String(Math.round(kb)), unit: 'KB/s' }
  const mb = kb / 1024
  return { value: mb < 10 ? mb.toFixed(2) : mb.toFixed(1), unit: 'MB/s' }
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}秒`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s === 0 ? `${m}分钟` : `${m}分${s}秒`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m === 0 ? `${h}小时` : `${h}小时${m}分`
}

export function remainingSeconds(task: { fileSize: number; completedBytes: number; bytesPerSecond: number }): number | null {
  if (task.bytesPerSecond <= 0 || task.fileSize <= task.completedBytes) return null
  return (task.fileSize - task.completedBytes) / task.bytesPerSecond
}

export function fractionOf(task: { fileSize: number; completedBytes: number; progressFraction?: number }): number {
  if (task.progressFraction != null && Number.isFinite(task.progressFraction)) {
    return Math.min(1, Math.max(0, task.progressFraction))
  }
  if (task.fileSize <= 0) return 0
  return Math.min(1, Math.max(0, task.completedBytes / task.fileSize))
}

export function inferCategory(filename: string): import('./types').DownloadCategory {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'flac'].includes(ext)) return 'audio'
  if (['pdf', 'doc', 'docx', 'txt', 'epub'].includes(ext)) return 'document'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'compressed'
  if (['exe', 'msi', 'pkg', 'apk', 'dmg', 'appimage'].includes(ext)) return 'application'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image'
  return 'misc'
}

export function filenameStem(filename: string): string {
  const trimmed = filename.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return trimmed
  return trimmed.slice(0, dot)
}

/** Webpage title is only worth showing when it is not the filename again. */
export function isDistinctTitle(title: string | undefined, filename: string): boolean {
  if (!title?.trim()) return false
  const placeholder = title
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  if (/^(justamoment|pleasewait|loading|正在加载|页面加载中|页面加载中请稍候|请稍候)$/.test(placeholder)) {
    return false
  }
  const normalize = (value: string): string => {
    let decoded = value
    try { decoded = decodeURIComponent(value) } catch { /* keep the original text */ }
    return decoded
      .normalize('NFKC')
      .trim()
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .replace(/[\p{P}\p{S}\s_]+/gu, '')
      .toLocaleLowerCase()
  }
  const left = normalize(title)
  const right = normalize(filename)
  if (!left || !right || left === right) return false

  const shorter = left.length <= right.length ? left : right
  const longer = left.length > right.length ? left : right
  const looksLikeDecoratedDuplicate = shorter.length >= 6
    && longer.includes(shorter)
    && (longer.length - shorter.length <= 16 || shorter.length / longer.length >= 0.78)
  return !looksLikeDecoratedDuplicate
}

const ORDINARY_FILE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz',
  'dmg', 'pkg', 'exe', 'msi', 'iso', 'apk', 'appimage',
  'pdf', 'epub', 'mobi', 'azw3', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'rtf', 'txt', 'md', 'csv',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg', 'ico',
  'json', 'xml', 'yaml', 'yml', 'toml', 'js', 'css', 'sh', 'py', 'swift', 'dat', 'bin',
  'gguf', 'safetensors', 'ckpt', 'onnx', 'pth', 'pt', 'tflite', 'mlmodel',
  'npy', 'npz', 'parquet', 'arrow',
  'ttf', 'otf', 'woff', 'woff2'
])

export function looksLikeOrdinaryFileDownload(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    const scheme = parsed.protocol.replace(':', '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp') return false
    const candidates = [parsed.pathname.split('/').pop() ?? '']
    for (const [key, value] of parsed.searchParams) {
      const name = key.toLowerCase()
      if (name.includes('filename') || name.includes('disposition') || name === 'rscd') {
        candidates.push(value)
      }
    }
    return candidates.some((candidate) => {
      const decoded = decodeURIComponent(candidate)
      const ext = decoded.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
      return ORDINARY_FILE_EXTENSIONS.has(ext)
    })
  } catch {
    return false
  }
}

export function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
    if (last && last.includes('.')) return last
  } catch {
    /* ignore */
  }
  return '未命名下载'
}
