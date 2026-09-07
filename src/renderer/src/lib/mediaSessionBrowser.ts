import { SESSION_BROWSER_OPTIONS, type SessionBrowser } from './sessionPrefs'
export type MediaSessionBrowser = Exclude<SessionBrowser, 'opera' | 'whale'>
export function mediaSessionBrowserOptions(windows = false) {
  return SESSION_BROWSER_OPTIONS.filter((option): option is {value: MediaSessionBrowser; label: string} =>
    option.value !== 'opera' && option.value !== 'whale' && (!windows || option.value !== 'safari'))
}
export function initialMediaSessionBrowser(preference: string, windows = false): MediaSessionBrowser | null {
  return mediaSessionBrowserOptions(windows).find(option => option.value === preference)?.value ?? null
}
