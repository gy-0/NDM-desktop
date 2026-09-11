import { extractSharedLinks } from './sharedLink'

export type ComposerBatchLink = { url: string; failed?: boolean }

/** Keep the user's review order and never re-add an accepted item on retry. */
export function appendBatchLinks(current: ComposerBatchLink[], text: string, accepted: ReadonlySet<string> = new Set()): ComposerBatchLink[] {
  const seen = new Set([...current.map(item => item.url), ...accepted])
  const added = extractSharedLinks(text).flatMap(({ urlString }) => {
    if (seen.has(urlString)) return []
    seen.add(urlString)
    return [{ url: urlString }]
  })
  return [...current, ...added]
}

export function batchLinkIdentity(value: string): { title: string; detail: string } {
  try {
    const url = new URL(value)
    if (url.protocol === 'magnet:') return { title: url.searchParams.get('dn') || '磁力链接', detail: 'BitTorrent' }
    let filename = url.pathname.split('/').filter(Boolean).at(-1) || ''
    try { filename = decodeURIComponent(filename) } catch { /* Keep the original when a URL uses malformed escapes. */ }
    const host = url.hostname.replace(/^www\./, '')
    return { title: filename || host, detail: host }
  } catch {
    return { title: value, detail: '下载链接' }
  }
}
