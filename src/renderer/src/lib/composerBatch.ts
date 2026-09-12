import { extractSharedLinks } from './sharedLink'
import type { ComposerDraft, ComposerDraftItem, ComposerDraftRequest } from '../../../shared/composerDraft'

/** Inputs remain unreviewed. A space also survives the single-line URL field. */
export function mergeComposerInput(...values: string[]): string {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].join(' ')
}

/** A failed initial read must not make edits disappear when storage recovers. */
export function mergeRecoveredDraft(saved: ComposerDraft, edited: ComposerDraft): ComposerDraft {
  const seen = new Set(saved.items.map(item => item.url))
  return {
    ...saved,
    input: mergeComposerInput(saved.input, edited.input),
    items: [...saved.items, ...edited.items.filter(item => !seen.has(item.url))],
    destination: edited.destination.mode === 'explicit' ? edited.destination : saved.destination,
    connections: edited.connections.mode === 'explicit' ? edited.connections : saved.connections
  }
}

export type ComposerBatchLink = { url: string; failed?: boolean } & Partial<Omit<ComposerDraftItem, 'url'>>

export function draftBatchLinks(links: ComposerBatchLink[]): ComposerDraftItem[] {
  return links.map(({ failed, ...item }) => ({ ...item, id: item.id || crypto.randomUUID(), status: item.status || (failed ? 'failed' : 'pending') }))
}

/** Only source metadata may survive a restart; credentials never enter a draft. */
export function draftCreationRequest(op: 'add' | 'addMedia', options: Record<string, unknown>): ComposerDraftRequest {
  const fields = ['url', 'creationKey', 'folderPath', 'connections', 'filename', 'autoStart', 'formatID', 'container', 'collectionScope', 'pageTitle', 'thumbnailURL', 'subtitleLanguage', 'cookieBrowser', ...(op === 'addMedia' ? ['browserSessionID'] : [])]
  return { op, options: Object.fromEntries(fields.filter(key => options[key] !== undefined).map(key => [key, options[key]])) as ComposerDraftRequest['options'] }
}

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
