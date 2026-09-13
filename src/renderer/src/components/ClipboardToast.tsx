import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference'
import './ui/activity-feedback.css'

// Keep the exit timer in sync with the --toast-close token in index.css.
function toastCloseMs(element: HTMLElement): number {
  const token = window.getComputedStyle(element).getPropertyValue('--toast-close').trim().toLowerCase()
  if (token === '0') return 0
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(token)
  // Production CSS may shorten 250ms to .25s.
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 250
}

type ClipboardToastProps = {
  url: string
  onDownload: (url: string) => void
  onDismiss: () => void
}

export function ClipboardToast(props: ClipboardToastProps) {
  // A new offer must not inherit a previous URL's pending dismissal clock.
  return <ClipboardOffer key={props.url} {...props} />
}

function ClipboardOffer({ url, onDownload, onDismiss }: ClipboardToastProps) {
  // t-toast choreography: mount open (rise in), play `.is-hiding` on dismiss,
  // then unmount via onDismiss once the close clock has run.
  const reduced = useReducedMotionPreference()
  const [action, setAction] = useState<'idle' | 'dismissing' | 'opening'>('idle')
  const committed = useRef(false)
  const dismissed = useRef(false)
  const toastRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const dismissRef = useRef(onDismiss)
  const hiding = action === 'dismissing'
  const inactive = action !== 'idle'

  useLayoutEffect(() => { dismissRef.current = onDismiss }, [onDismiss])
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !toastRef.current?.contains(active)) returnFocus.current = active
  }, [])

  useEffect(() => {
    if (!hiding || !toastRef.current) return
    const timer = window.setTimeout(() => {
      if (dismissed.current) return
      dismissed.current = true
      dismissRef.current()
    }, reduced ? 0 : toastCloseMs(toastRef.current))
    return () => window.clearTimeout(timer)
  }, [hiding, reduced])

  const restoreFocus = (): void => {
    if (!toastRef.current?.contains(document.activeElement)) return
    // Move focus before making the leaving surface inert. This also gives the
    // Composer a connected return target when the offer opens it.
    for (const target of [returnFocus.current, document.getElementById('ndm-search')]) {
      if (!target?.isConnected || target.closest('[inert], [aria-hidden="true"]') || !target.getClientRects().length) continue
      target.focus({ preventScroll: true })
      if (document.activeElement === target) return
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  const beginDismiss = (): void => {
    if (committed.current) return
    committed.current = true
    restoreFocus()
    setAction('dismissing')
  }

  const beginDownload = (): void => {
    if (committed.current) return
    committed.current = true
    restoreFocus()
    setAction('opening')
    onDownload(url)
  }

  const filename = (() => {
    try {
      const u = new URL(url)
      const pathname = u.pathname
      const name = pathname.substring(pathname.lastIndexOf('/') + 1)
      return name ? decodeURIComponent(name) : u.hostname
    } catch {
      return url
    }
  })()

  return (
    <div
      ref={toastRef}
      role="region"
      aria-label="剪贴板下载提示"
      aria-hidden={inactive || undefined}
      inert={inactive}
      data-clipboard-state={action}
      data-reduced-motion={reduced}
      className={`t-toast clipboard-toast ${hiding ? 'is-hiding' : 'is-open'}`}
      onFocusCapture={event => {
        const previous = event.relatedTarget
        if (previous instanceof HTMLElement && previous !== document.body && !event.currentTarget.contains(previous)) returnFocus.current = previous
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        beginDismiss()
      }}
    >
      <div className="clipboard-toast-icon" aria-hidden>
        <Download size={18} strokeWidth={1.7} />
      </div>
      <div className="clipboard-toast-identity" role="status" aria-live="polite" aria-atomic="true">
        <div className="clipboard-toast-label">剪贴板链接</div>
        <div className="clipboard-toast-filename" title={url}>
          {filename}
        </div>
      </div>
      <div className="clipboard-toast-actions">
        <button
          type="button"
          onClick={beginDownload}
          disabled={inactive}
          aria-busy={action === 'opening' || undefined}
          className="clipboard-toast-download"
        >
          立即下载
        </button>
        <button
          type="button"
          onClick={beginDismiss}
          disabled={inactive}
          aria-label="关闭剪贴板提示"
          className="clipboard-toast-close"
        >
          <X size={14} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </div>
  )
}
