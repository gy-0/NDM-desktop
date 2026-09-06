import { useEffect, useState } from 'react'

/**
 * The browser whose logged-in session NDM borrows when a download wall
 * answers with a login page. Only the browser *name* is stored — cookie
 * values themselves never leave the main process and are never persisted.
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
