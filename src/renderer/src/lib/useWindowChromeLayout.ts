import { useLayoutEffect, useRef, useState } from 'react'
import { libraryTitlebarLayout, type WindowChromeState } from '../../../shared/windowChrome'

/** Observe real pane geometry: a saved sidebar width, an overlay pane and
 * renderer zoom can all change where the toolbar meets the native titlebar. */
export function useWindowChromeLayout() {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

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
      const layout = libraryTitlebarLayout({
        platform: window.ndm?.platform ?? 'web',
        fullScreen: chrome.fullScreen,
        zoomFactor: window.ndm?.getWindowZoomFactor?.() ?? 1,
        paneLeft: rect.left,
        paneTop: rect.top,
        paneWidth: rect.width
      })
      const layoutKey = `${layout.paddingTop}:${layout.controlsInset}`
      if (layoutKey !== previousLayout) {
        previousLayout = layoutKey
        toolbar.style.setProperty('--titlebar-padding-top', `${layout.paddingTop}px`)
        toolbar.style.setProperty('--titlebar-controls-inset', `${layout.controlsInset}px`)
      }
      setSidebarOpen(Boolean(sidebar?.getBoundingClientRect().width))
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
    update()
    return () => {
      disposed = true
      stopChrome?.()
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return { toolbarRef, sidebarOpen }
}
