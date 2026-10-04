/** Native window coordinates are device-independent pixels, not renderer CSS
 * pixels. Keep the reservation and BrowserWindow placement in one contract. */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 }
export const WINDOWS_TITLEBAR_HEIGHT = 52
export const WINDOWS_WINDOW_CONTROLS_WIDTH = 138
export const MAC_WINDOW_CONTROL_SAFE_AREA = {
  right: MAC_TRAFFIC_LIGHT_POSITION.x + 56 + 16,
  bottom: MAC_TRAFFIC_LIGHT_POSITION.y + 16 + 14
}

export interface WindowChromeState {
  fullScreen: boolean
}

/** Convert the native overlay height to renderer CSS pixels. */
export function windowsTitlebarHeight(fullScreen: boolean, zoomFactor: number): number {
  if (fullScreen) return 0
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return WINDOWS_TITLEBAR_HEIGHT / zoom
}

export function windowsPaneTitlebarLayout({ paneLeft, paneTop, paneWidth, viewportWidth, controlsWidth, controlsHeight }: {
  paneLeft: number; paneTop: number; paneWidth: number; viewportWidth: number; controlsWidth: number; controlsHeight: number
}): { paddingTop: number; controlsInsetRight: number } {
  const base = { paddingTop: 12, controlsInsetRight: 0 }
  if (paneTop + base.paddingTop >= controlsHeight) return base
  // Keep a 12px breathing space between application actions and native controls.
  const inset = Math.max(0, paneLeft + paneWidth - (viewportWidth - controlsWidth) - 4)
  if (!inset) return base
  // Only crowded panes move their search row below native controls.
  if (paneWidth - 32 - inset < 360) return { paddingTop: Math.max(12, controlsHeight - paneTop), controlsInsetRight: 0 }
  // The search row is 32 CSS px high; align its centre with the native strip.
  // At large renderer zoom, retain a minimum top margin.
  return { paddingTop: Math.max(8, (controlsHeight - 32) / 2 - paneTop), controlsInsetRight: inset }
}

export function libraryTitlebarLayout({
  platform,
  fullScreen,
  zoomFactor,
  paneLeft,
  paneTop,
  paneWidth
}: {
  platform: string
  fullScreen: boolean
  zoomFactor: number
  paneLeft: number
  paneTop: number
  paneWidth: number
}): { paddingTop: number; controlsInset: number } {
  const base = { paddingTop: 12, controlsInset: 0 }
  if (platform !== 'darwin' || fullScreen) return base
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const safeRight = MAC_WINDOW_CONTROL_SAFE_AREA.right / zoom
  const safeBottom = MAC_WINDOW_CONTROL_SAFE_AREA.bottom / zoom
  if (paneTop + base.paddingTop >= safeBottom) return base

  const inset = Math.max(0, safeRight - paneLeft - 16)
  if (!inset) return base
  // Preserve a useful search field in compact windows. Only the titlebar row
  // moves below the native controls; the library heading keeps its left edge.
  if (paneWidth - 32 - inset < 360) {
    return { paddingTop: Math.max(base.paddingTop, safeBottom - paneTop), controlsInset: 0 }
  }
  // At zoom-out, even the second row can enter the physical titlebar. Keep
  // its unindented heading below the controls (32px first row + 8px row gap).
  return { paddingTop: Math.max(base.paddingTop, safeBottom - paneTop - 40), controlsInset: inset }
}
