import { useLayoutEffect, useRef } from 'react'
import { libraryTitlebarLayout, windowsPaneTitlebarLayout, WINDOWS_WINDOW_CONTROLS_WIDTH, windowsTitlebarHeight, type WindowChromeState } from '../../../shared/windowChrome'

/** Observe real pane geometry: a saved sidebar width, an overlay pane and
 * renderer zoom can all change where the toolbar meets the native titlebar. */
export function useWindowChromeLayout() {
  const toolbarRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const sidebar = document.getElementById('main-sidebar')
    let chrome: WindowChromeState = { fullScreen: false }
    let receivedChromeEvent = false
    let disposed = false
    let previousLayout = ''
    const update = (): void => {
      if (disposed) return
      const rect = toolbar.getBoundingClientRect()
      const reportedZoom = window.ndm?.getWindowZoomFactor?.() ?? 1
      const zoom = Number.isFinite(reportedZoom) && reportedZoom > 0 ? reportedZoom : 1
      const isWindows = window.ndm?.platform === 'win32'
      const rootStyle = document.documentElement.style
      const windowsLayout = isWindows ? windowsPaneTitlebarLayout({
        paneLeft: rect.left, paneTop: rect.top, paneWidth: rect.width, viewportWidth: window.innerWidth,
        controlsWidth: chrome.fullScreen ? 0 : parseFloat(rootStyle.getPropertyValue('--window-controls-width')) || WINDOWS_WINDOW_CONTROLS_WIDTH / zoom,
        controlsHeight: chrome.fullScreen ? 0 : parseFloat(rootStyle.getPropertyValue('--window-controls-height')) || windowsTitlebarHeight(false, zoom)
      }) : null
      const macLayout = libraryTitlebarLayout({
        platform: window.ndm?.platform ?? 'web',
        fullScreen: chrome.fullScreen,
        zoomFactor: zoom,
        paneLeft: rect.left,
        paneTop: rect.top,
        paneWidth: rect.width
      })
      const layout = { paddingTop: windowsLayout?.paddingTop ?? macLayout.paddingTop, controlsInset: macLayout.controlsInset, controlsInsetRight: windowsLayout?.controlsInsetRight ?? 0 }
      const layoutKey = `${layout.paddingTop}:${layout.controlsInset}:${layout.controlsInsetRight}`
      if (layoutKey !== previousLayout) {
        previousLayout = layoutKey
        toolbar.style.setProperty('--titlebar-padding-top', `${layout.paddingTop}px`)
        toolbar.style.setProperty('--titlebar-controls-inset', `${layout.controlsInset}px`)
        toolbar.style.setProperty('--titlebar-controls-right-inset', `${layout.controlsInsetRight}px`)
      }
    }
    const stopChrome = window.ndm?.onWindowChromeChanged?.(state => {
      receivedChromeEvent = true
      chrome = state
      update()
    })
    void window.ndm?.getWindowChrome?.().then(state => {
      // An initial IPC reply must not undo a newer fullscreen transition.
      if (receivedChromeEvent || disposed) return
      chrome = state
      update()
    }).catch(() => undefined)
    const observer = new ResizeObserver(update)
    observer.observe(toolbar)
    if (sidebar) observer.observe(sidebar)
    window.addEventListener('resize', update)
    window.addEventListener('ndm-window-controls-changed', update)
    update()
    return () => {
      disposed = true
      stopChrome?.()
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('ndm-window-controls-changed', update)
    }
  }, [])

  return { toolbarRef }
}
