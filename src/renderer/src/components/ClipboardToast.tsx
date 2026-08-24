import { useEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'

// Keep the exit timer in sync with the --toast-close token in index.css.
function toastCloseMs(): number {
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--toast-close')
  )
  return Number.isFinite(value) ? value : 250
}

export function ClipboardToast({
  url,
  onDownload,
  onDismiss
}: {
  url: string
  onDownload: (url: string) => void
  onDismiss: () => void
}) {
  // t-toast choreography: mount open (rise in), play `.is-hiding` on dismiss,
  // then unmount via onDismiss once the close clock has run.
  const [hiding, setHiding] = useState(false)
  const hideTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    }
  }, [])

  const beginDismiss = (): void => {
    if (hiding) return
    setHiding(true)
    hideTimer.current = window.setTimeout(onDismiss, toastCloseMs())
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
      className={`t-toast absolute bottom-6 right-6 z-40 flex items-center gap-3 rounded-xl border border-line-strong bg-raised px-4 py-3 shadow-[0_12px_28px_-16px_rgb(0_0_0/0.68)] ${hiding ? 'is-hiding' : 'is-open'}`}
      style={{ maxWidth: 440 }}
    >
      <div className="shrink-0 text-fog">
        <Download size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-fog">剪贴板中的下载链接</div>
        <div className="truncate text-[12px] text-paper" title={url}>
          {filename}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onDownload(url)}
          className="rounded-lg bg-accent px-3 py-1.5 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-paper"
        >
          立即下载
        </button>
        <button
          type="button"
          onClick={beginDismiss}
          className="rounded-lg p-1.5 text-mist transition-colors hover:bg-white/10 hover:text-paper"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
