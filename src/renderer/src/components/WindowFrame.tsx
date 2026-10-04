import { useLayoutEffect, type ReactNode } from 'react'
import { WINDOWS_WINDOW_CONTROLS_WIDTH, windowsTitlebarHeight, type WindowChromeState } from '../../../shared/windowChrome'
import { IS_WINDOWS } from '../lib/platform'
import './ui/window-frame.css'

interface ControlsOverlay extends EventTarget {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
}

export function WindowFrame({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    if (!IS_WINDOWS) return
    const root = document.documentElement
    let chrome: WindowChromeState = { fullScreen: false }
    let receivedEvent = false
    let disposed = false
    const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
    const update = (): void => {
      if (disposed) return
      const reportedZoom = window.ndm?.getWindowZoomFactor?.() ?? 1
      const zoom = Number.isFinite(reportedZoom) && reportedZoom > 0 ? reportedZoom : 1
      let height = windowsTitlebarHeight(chrome.fullScreen, zoom)
      let width = chrome.fullScreen ? 0 : WINDOWS_WINDOW_CONTROLS_WIDTH / zoom
      if (!chrome.fullScreen && overlay?.visible) {
        const safe = overlay.getTitlebarAreaRect()
        height = safe.height
        width = Math.max(0, window.innerWidth - safe.right)
      }
      root.style.setProperty('--window-controls-height', `${height}px`)
      root.style.setProperty('--window-controls-width', `${width}px`)
      root.dataset.windowFullscreen = String(chrome.fullScreen)
      window.dispatchEvent(new Event('ndm-window-controls-changed'))
    }
    const stop = window.ndm?.onWindowChromeChanged?.(state => {
      receivedEvent = true
      chrome = state
      update()
    })
    void window.ndm?.getWindowChrome?.().then(state => {
      if (receivedEvent || disposed) return
      chrome = state
      update()
    }).catch(() => undefined)
    window.addEventListener('resize', update)
    overlay?.addEventListener('geometrychange', update)
    update()
    return () => {
      disposed = true
      stop?.()
      window.removeEventListener('resize', update)
      overlay?.removeEventListener('geometrychange', update)
      root.style.removeProperty('--window-controls-height')
      root.style.removeProperty('--window-controls-width')
      delete root.dataset.windowFullscreen
    }
  }, [])

  // Native controls share existing surfaces; no extra caption row is drawn.
  return children
}
