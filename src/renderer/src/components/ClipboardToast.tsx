import { Download, X } from 'lucide-react'

export function ClipboardToast({
  url,
  onDownload,
  onDismiss
}: {
  url: string
  onDownload: (url: string) => void
  onDismiss: () => void
}) {
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
      className="absolute bottom-6 right-6 z-40 flex items-center gap-3 rounded-2xl border border-copper/40 bg-raised/95 px-4 py-3 shadow-[0_20px_50px_rgba(0,0,0,0.6)] backdrop-blur-xl animate-fade-up"
      style={{ maxWidth: 440 }}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-copper/15 text-copper">
        <Download size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-copper">检测到剪贴板下载链接</div>
        <div className="truncate font-mono text-[12px] text-paper" title={url}>
          {filename}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onDownload(url)}
          className="rounded-lg bg-copper px-3 py-1.5 text-[11.5px] font-medium text-on-accent transition-transform active:scale-95"
        >
          立即下载
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg p-1.5 text-mist transition-colors hover:bg-white/10 hover:text-paper"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
