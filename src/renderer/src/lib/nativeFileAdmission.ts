import type { AddDownloadOptions } from './types'
import { hasProxyTargetPointer } from './format'
import { isKnownMediaSiteURL } from './sharedLink'

// Conservative subset of the Swift HTTPFileResponsePolicy: these ordinary
// files reject HTML on the actual response, before publishing any output.
const protectedExtensions = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'dmg', 'pkg', 'exe', 'msi', 'apk', 'iso', 'bin'])
const protectedName = (name: string): boolean => protectedExtensions.has(name.split('.').pop()?.toLowerCase() ?? '')

export function canStartNativeFileDirectly(options: AddDownloadOptions & { method?: string; body?: string; postData?: string }, platform?: string): boolean {
  if (platform !== 'darwin' || options.formatID || options.browserSessionID || options.cookieBrowser ||
      options.headers?.length || options.method && options.method.toUpperCase() !== 'GET' ||
      options.body !== undefined || options.postData !== undefined ||
      hasProxyTargetPointer(options.url) || isKnownMediaSiteURL(options.url)) return false
  try {
    const url = new URL(options.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    // The host may derive a different filename from these response-name hints.
    for (const key of url.searchParams.keys()) {
      if (/filename|disposition/i.test(key) || key.toLowerCase() === 'rscd') return false
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    return protectedName(name) && protectedName(options.filename?.trim() || name)
  } catch { return false }
}
