/** Discovery is metadata only. Resource URLs and credentials never enter this API. */
export type BrowserPageMediaItem = { mediaKey: string; title: string; meta: string; badge: string; kind: string; quality: string }
export type BrowserPageMediaSource = { sourceToken: string; pageURL: string; title: string; browser: string; incognito: boolean; items: BrowserPageMediaItem[] }
export type BrowserPageMediaChoice = { sourceToken: string; mediaKey: string; pageURL: string }
export type BrowserPageMediaCreate = BrowserPageMediaChoice & { creationKey: string; filename?: string; folderPath?: string; connections: number }

/** A pending admission belongs to its original form. Reopening the composer
 * with another URL must never replay that admission as the new URL's result. */
export function browserPageMediaPendingConflict(pending: BrowserPageMediaCreate | null, pageURL: string): boolean {
  return pending !== null && pending.pageURL !== pageURL
}

/** Worker connections do not reveal browser profile names. Identical labels
 * must not turn an arbitrary source index into an apparent account choice. */
export function ambiguousBrowserPageMediaSources(sources: BrowserPageMediaSource[]): boolean {
  const labels = sources.map(source => JSON.stringify([source.browser.toLowerCase(), source.title.trim(), source.incognito]))
  return new Set(labels).size !== labels.length
}

export function browserPageMediaURL(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || input.length > 4096
      || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return null
    const ids = url.searchParams.getAll('modal_id')
    if (ids.length > 1 || ids.length === 1 && !/^\d{1,32}$/.test(ids[0])) return null
    if (/^\/video\/\d{1,32}\/?$/.test(url.pathname)) return ids.length && ids[0] !== url.pathname.split('/').filter(Boolean).at(-1) ? null : `https://www.douyin.com${url.pathname.replace(/\/$/, '')}`
    if (url.pathname.startsWith('/video/') || ids.length !== 1 || !/^\d{1,32}$/.test(ids[0])) return null
    return `https://www.douyin.com/video/${ids[0]}`
  } catch { return null }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function readBrowserPageMediaSources(reply: unknown, pageURL: string): BrowserPageMediaSource[] {
  const invalid = (): never => { throw new Error('浏览器返回的视频列表无效，请重新读取页面。') }
  if (!browserPageMediaURL(pageURL) || !object(reply) || reply.ok !== true || !Array.isArray(reply.sources) || reply.sources.length > 64) return invalid()
  const sources: BrowserPageMediaSource[] = []
  for (const source of reply.sources) {
    if (!object(source) || !exact(source, ['sourceToken', 'pageURL', 'title', 'browser', 'incognito', 'items'])
      || !text(source.sourceToken, 36) || !uuid.test(source.sourceToken) || !text(source.pageURL, 4096)
      || browserPageMediaURL(source.pageURL) !== browserPageMediaURL(pageURL) || !text(source.title, 1024)
      || !text(source.browser, 32) || typeof source.incognito !== 'boolean' || !Array.isArray(source.items)
      || source.items.length < 1 || source.items.length > 6) return invalid()
    const items: BrowserPageMediaItem[] = []
    for (const item of source.items) {
      if (!object(item) || !exact(item, ['mediaKey', 'title', 'meta', 'badge', 'kind', 'quality'])
        || !text(item.mediaKey, 128) || !/^[a-zA-Z0-9:_-]{16,128}$/.test(item.mediaKey)
        || !text(item.title, 512) || !text(item.meta, 256) || !text(item.badge, 64) || item.kind !== 'video'
        || !text(item.quality, 128)) return invalid()
      items.push(item as BrowserPageMediaItem)
    }
    if (new Set(items.map(item => item.mediaKey)).size !== items.length) return invalid()
    sources.push({ ...source, items } as BrowserPageMediaSource)
  }
  if (new Set(sources.map(source => source.sourceToken)).size !== sources.length) return invalid()
  return sources
}

export function selectedBrowserPageMedia(sources: BrowserPageMediaSource[], choice: BrowserPageMediaChoice | null, pageURL: string): BrowserPageMediaItem | null {
  if (!choice || choice.pageURL !== pageURL) return null
  return sources.find(source => source.sourceToken === choice.sourceToken && browserPageMediaURL(source.pageURL) === browserPageMediaURL(pageURL))?.items.find(item => item.mediaKey === choice.mediaKey) ?? null
}

/** Only categorical, known messages reach the composer, never transport stderr. */
export function browserPageMediaError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const known = ['请更新 NDM Relay 扩展，并刷新已打开的视频页面后重试。', '未找到当前页面的视频版本。请在原浏览器打开此视频并播放，再读取页面。',
    '浏览器页面或视频版本已变化，请重新读取页面后选择版本。', '浏览器正在处理上一次请求，请稍后重试。',
    '浏览器未及时响应，请确认扩展已连接后重试。', '浏览器返回的视频信息无效，请刷新来源页面后重试。', '浏览器返回的视频列表无效，请重新读取页面。']
  return known.find(value => message.includes(value)) ?? '读取浏览器页面未完成，请确认 NDM Relay 已更新并连接后重试。'
}
