import { parseBrowserSelection } from '../../../shared/browserSessions'
import { useEffect, useState } from 'react'

/**
 * The browser whose logged-in session NDM borrows when a download wall
 * answers with a login page. Preferences store a browser name and optional
 * profile directory ID. No cookie values or account identifiers are stored here.
 */
export type SessionBrowser =
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'safari'
  | 'brave'
  | 'chromium'
  | 'opera'
  | 'whale'

export const SESSION_BROWSER_OPTIONS: ReadonlyArray<{
  value: SessionBrowser
  label: string
}> = [
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'safari', label: 'Safari' },
  { value: 'brave', label: 'Brave' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'opera', label: 'Opera' },
  { value: 'whale', label: 'Whale' }
]

const DEFAULT_SESSION_BROWSER: SessionBrowser = 'chrome'
const STORAGE_KEY = 'ndm.session.browser'
const CHANGE_EVENT = 'ndm-session-browser-change'

export function readSessionBrowser(): SessionBrowser {
  if (typeof window === 'undefined') return DEFAULT_SESSION_BROWSER
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && SESSION_BROWSER_OPTIONS.some((option) => option.value === stored)) {
      return stored as SessionBrowser
    }
  } catch {
    // Storage may be unavailable; the default still applies below.
  }
  return DEFAULT_SESSION_BROWSER
}

export function writeSessionBrowser(browser: SessionBrowser): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, browser)
  } catch {
    // The current window still uses the selection even when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<SessionBrowser>(CHANGE_EVENT, { detail: browser }))
}

export function useSessionBrowser(): SessionBrowser {
  const [browser, setBrowser] = useState(readSessionBrowser)
  useEffect(() => {
    const onChange = (event: Event): void => setBrowser((event as CustomEvent<SessionBrowser>).detail)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])
  return browser
}

/** Only profile directory IDs are preferences; never account names or cookies. */
export function readSessionCookieBrowser(browser: string = readSessionBrowser()): string {
  if (browser.includes(':')) return browser
  try {
    const profile = window.localStorage.getItem(`ndm.session.profile.${browser}`)
    if (profile && parseBrowserSelection(`${browser}:${profile}`)) return `${browser}:${profile}`
  } catch { /* Automatic profile selection remains available. */ }
  return browser
}
export function writeSessionProfile(browser: SessionBrowser, profile: string): void {
  if (profile && !parseBrowserSelection(`${browser}:${profile}`)) return
  try {
    if (profile) window.localStorage.setItem(`ndm.session.profile.${browser}`, profile)
    else window.localStorage.removeItem(`ndm.session.profile.${browser}`)
  } catch { /* The selector still shows the requested change in this window. */ }
  window.dispatchEvent(new CustomEvent<SessionBrowser>(CHANGE_EVENT, { detail: browser }))
}
