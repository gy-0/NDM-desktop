/** Opaque Relay handoff identity. Credentials stay in the native session store;
 * this random lookup ID lets reviewed requests renew their originating profile. */
export type BrowserMediaSession = { id: string; url: string; browser?: string }

export function mediaSessionURL(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

export function browserMediaSessionFromEvent(message: Record<string, unknown>): BrowserMediaSession | null {
  const id = message.browserSessionID
  const url = typeof message.url === 'string' ? mediaSessionURL(message.url) : null
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !url) return null
  const browser = typeof message.browserSessionBrowser === 'string' ? message.browserSessionBrowser : undefined
  return { id, url, browser }
}
