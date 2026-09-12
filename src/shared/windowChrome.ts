/** Native window coordinates are device-independent pixels, not renderer CSS
 * pixels. Keep the reservation and BrowserWindow placement in one contract. */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 }
export const MAC_WINDOW_CONTROL_SAFE_AREA = {
  right: MAC_TRAFFIC_LIGHT_POSITION.x + 56 + 16,
  bottom: MAC_TRAFFIC_LIGHT_POSITION.y + 16 + 14
}

export interface WindowChromeState {
  fullScreen: boolean
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
