export const SESSION_BROWSERS = ['chrome', 'edge', 'firefox', 'safari', 'brave', 'chromium', 'opera', 'whale'] as const
export type SessionBrowserID = typeof SESSION_BROWSERS[number]
export const PROFILE_BROWSERS = ['chrome', 'edge', 'brave', 'chromium', 'whale'] as const
export type BrowserSessionSource = {
  browser: SessionBrowserID
  profile?: string
  selector: string
  label: string
  selection: 'automatic' | 'manual' | 'browserDefault'
}
export type BrowserSessionCatalog = {
  browser: SessionBrowserID
  profiles: { id: string; label: string; current: boolean }[]
  source?: BrowserSessionSource
  error?: string
  code?: 'invalidChoice' | 'noBrowserData' | 'profileSelectionRequired'
}
export function parseBrowserSelection(value: unknown): { browser: SessionBrowserID; profile?: string } | null {
  if (typeof value !== 'string' || value.length > 96 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null
  const [browser, profile, extra] = value.split(':')
  if (extra !== undefined || !SESSION_BROWSERS.includes(browser as SessionBrowserID)) return null
  if (profile !== undefined && (!PROFILE_BROWSERS.includes(browser as typeof PROFILE_BROWSERS[number]) || !/^(?:Default|Profile [1-9]\d{0,5})$/.test(profile))) return null
  return { browser: browser as SessionBrowserID, ...(profile ? { profile } : {}) }
}
export function browserLabel(browser: SessionBrowserID): string {
  return ({ chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', brave: 'Brave', chromium: 'Chromium', opera: 'Opera', whale: 'Whale' })[browser]
}
export function profileLabel(profile: string): string { return profile === 'Default' ? '默认个人资料' : `个人资料 ${profile.slice(8)}` }
