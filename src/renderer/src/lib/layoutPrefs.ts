export const SIDEBAR_WIDTH_KEY = 'ndm.sidebar.width'
export const SIDEBAR_WIDTH_MIN = 196
export const SIDEBAR_WIDTH_DEFAULT = 216
export const SIDEBAR_WIDTH_MAX = 288

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

export function readSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : SIDEBAR_WIDTH_DEFAULT
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
  } catch {
    /* ignore unavailable storage */
  }
}
