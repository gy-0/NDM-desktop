import { resolveSharedLink, type SharedLinkResolution } from './sharedLink'

export type ClipboardTaskRef = {
  url: string
  pageURL?: string
}

export type ClipboardOfferDecision =
  | { kind: 'keep' }
  | { kind: 'hide' }
  | { kind: 'show'; urlString: string }

const FILE_DOWNLOAD_EXPRESSION =
  /\.(dmg|zip|pkg|tar|gz|7z|rar|mp4|mkv|mov|avi|mp3|m4a|pdf|iso|exe|apk|bin|flv|m3u8)($|\?)/i

const TRACKING_QUERY_NAMES = new Set([
  'feature',
  'si',
  'spm_id_from',
  'share_source',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_tag',
  'share_token',
  'is_from_webapp',
  'sender_device',
  'sender_web_id',
  'share_app_id'
])

export function isClipboardDownloadCandidate(resolution: SharedLinkResolution | null): boolean {
  if (!resolution) return false
  if (resolution.source !== 'web') return true
  return FILE_DOWNLOAD_EXPRESSION.test(resolution.urlString)
}

export function resolveClipboardCandidate(raw: string): SharedLinkResolution | null {
  const resolution = resolveSharedLink(raw)
  return isClipboardDownloadCandidate(resolution) ? resolution : null
}

export function canonicalClipboardKey(raw: string): string | null {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const scheme = url.protocol.replace(':', '').toLowerCase()
  if (scheme === 'magnet') return `magnet:${trimmed.toLowerCase()}`
  if (!['http', 'https', 'ftp'].includes(scheme)) return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be' && parts[0]) return `youtube:video:${parts[0]}`
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const id = url.searchParams.get('v')
    if (id) return `youtube:video:${id}`
    if (parts[0] && ['shorts', 'live', 'embed'].includes(parts[0].toLowerCase()) && parts[1]) {
      return `youtube:video:${parts[1]}`
    }
  }
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    const id = parts.find((part) => /^bv/i.test(part) || /^av\d+$/i.test(part))
    if (id) return `bilibili:video:${id.toLowerCase()}`
  }
  if ((host === 'douyin.com' || host.endsWith('.douyin.com')) && parts.includes('video')) {
    const id = parts[parts.indexOf('video') + 1]
    if (id) return `douyin:video:${id}`
  }

  url.hash = ''
  url.hostname = host
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !name.toLowerCase().startsWith('utm_') && !TRACKING_QUERY_NAMES.has(name.toLowerCase()))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
    )
  url.search = ''
  for (const [name, value] of kept) url.searchParams.append(name, value)
  if (!url.pathname) url.pathname = '/'
  return `url:${url.toString()}`
}

export function libraryHasClipboardUrl(tasks: readonly ClipboardTaskRef[], url: string): boolean {
  const wanted = canonicalClipboardKey(url)
  return tasks.some((task) => {
    const candidates = [task.url, task.pageURL].filter((value): value is string => Boolean(value))
    return candidates.some((candidate) => candidate === url || (wanted !== null && canonicalClipboardKey(candidate) === wanted))
  })
}

export function decideClipboardOffer({
  changeCount,
  handledChangeCount,
  lastObservedChangeCount,
  urlString,
  inLibrary,
  selfWritten,
  composerOpen,
  offeredUrl
}: {
  changeCount: number
  handledChangeCount: number | null
  lastObservedChangeCount: number | null
  urlString: string | null
  inLibrary: boolean
  selfWritten: boolean
  composerOpen: boolean
  offeredUrl: string | null
}): ClipboardOfferDecision {
  if (composerOpen || selfWritten) return { kind: 'hide' }

  if (handledChangeCount === changeCount) {
    if (offeredUrl && inLibrary) return { kind: 'hide' }
    return { kind: 'keep' }
  }

  if (!urlString) return { kind: 'hide' }

  const generationChanged =
    lastObservedChangeCount !== null && lastObservedChangeCount !== changeCount
  if (inLibrary && !generationChanged) return { kind: 'hide' }
  return { kind: 'show', urlString }
}
