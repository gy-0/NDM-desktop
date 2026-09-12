import { CircleAlert, ExternalLink, Eye, File, FolderOpen, LoaderCircle, Share2, type LucideIcon } from 'lucide-react'
import { type DragEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { formatBytes } from '../lib/format'
import { deliveryFileKind, runFileDeliveryAction, type FileDeliveryAction, type FileDeliveryHandler } from '../lib/fileDelivery'
import type { TaskArtwork } from '../lib/taskThumbnail'
import './ui/completed-file-card.css'

export type CompletedFileCardProps = {
  /** A full path or task ID: filenames alone are not unique between folders. */
  fileKey: string | number
  filename: string
  artwork?: TaskArtwork | null
  /** Omit when the enclosing task summary already displays the size. */
  byteCount?: number
  fileManager: string
  openLabel?: string
  openIcon?: LucideIcon
  openBusy?: boolean
  onOpen: FileDeliveryHandler
  onPreview: FileDeliveryHandler
  onReveal: FileDeliveryHandler
  onShare?: FileDeliveryHandler
  onFileDrag?: (event: DragEvent<HTMLButtonElement>) => void
}

/** A selected file's preview and immediate next actions. It does not duplicate
 * the enclosing Inspector title or take focus when the selection changes. */
export function CompletedFileCard({
  fileKey, filename, artwork, byteCount, fileManager,
  openLabel = '打开文件', openIcon: OpenIcon = ExternalLink, openBusy = false,
  onOpen, onPreview, onReveal, onShare, onFileDrag
}: CompletedFileCardProps) {
  const noticeId = useId()
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<FileDeliveryAction | null>(null)
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null)
  const generation = useRef(0)
  const pendingRef = useRef<FileDeliveryAction | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    generation.current += 1
    pendingRef.current = null
    setPending(null)
    setNotice(null)
    setFailedArtwork(null)
    return () => {
      generation.current += 1
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [fileKey])

  const run = async (action: FileDeliveryAction, handler: FileDeliveryHandler): Promise<void> => {
    if (pendingRef.current) return
    const requested = ++generation.current
    pendingRef.current = action
    setPending(action)
    setNotice(null)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    const message = await runFileDeliveryAction(action, handler)
    if (requested !== generation.current) return
    pendingRef.current = null
    setPending(null)
    if (!message) return
    setNotice(message)
    noticeTimer.current = setTimeout(() => {
      if (requested === generation.current) setNotice(null)
    }, 3000)
  }

  const image = artwork && artwork.source !== failedArtwork ? artwork : null
  const hasPreview = image?.kind === 'preview'
  const fileKind = deliveryFileKind(filename)
  const metadata = byteCount && byteCount > 0 ? `${fileKind} · ${formatBytes(byteCount)}` : fileKind
  const busy = pending !== null

  return (
    <section className="completed-file-card" data-completed-file-card aria-label="使用文件" aria-describedby={notice ? noticeId : undefined}>
      <button
        type="button"
        className={`completed-file-preview ${hasPreview ? 'completed-file-preview-image' : 'completed-file-preview-compact'}`}
        aria-label="预览"
        title={`预览 ${filename} · 空格${onFileDrag ? ' · 拖出以使用文件' : ''}`}
        disabled={busy}
        aria-busy={pending === 'preview'}
        draggable={Boolean(onFileDrag)}
        onDragStart={onFileDrag}
        onClick={() => void run('preview', onPreview)}
      >
        {image ? (
          <img
            className="completed-file-artwork"
            src={image.source}
            alt=""
            draggable={false}
            onError={() => setFailedArtwork(image.source)}
          />
        ) : <File aria-hidden size={34} strokeWidth={1.3} className="completed-file-fallback" />}
        <span className="completed-file-preview-caption">
          <span className="completed-file-kind text-label">{metadata}</span>
          <span className="completed-file-preview-hint text-meta">
            {pending === 'preview' ? <LoaderCircle aria-hidden size={12} className="animate-spin" /> : <Eye aria-hidden size={12} />}
            预览 <kbd aria-hidden>空格</kbd>
          </span>
        </span>
      </button>

      <div className="completed-file-toolbar" data-inspector-actions>
        <button
          type="button"
          className="completed-file-open h-control text-label"
          disabled={busy || openBusy}
          aria-busy={openBusy || pending === 'open'}
          onClick={() => void run('open', onOpen)}
        >
          {openBusy || pending === 'open'
            ? <LoaderCircle size={14} aria-hidden className="animate-spin" />
            : <OpenIcon size={14} aria-hidden />}
          {openLabel}
        </button>
        <button
          type="button"
          className="completed-file-tool h-control text-label"
          aria-label={`在${fileManager}中显示`}
          title={`在${fileManager}中显示`}
          disabled={busy}
          onClick={() => void run('reveal', onReveal)}
        >
          <FolderOpen size={14} aria-hidden />{fileManager}
        </button>
        {onShare ? (
          <button
            type="button"
            className="completed-file-tool completed-file-share h-control"
            aria-label="分享"
            title="分享文件"
            disabled={busy}
            onClick={() => void run('share', onShare)}
          ><Share2 size={14} aria-hidden /></button>
        ) : null}
      </div>
      {notice ? (
        <div id={noticeId} className="completed-file-notice text-label" data-file-delivery-notice role="status" aria-live="polite">
          <CircleAlert size={13} aria-hidden />
          <span>{notice}</span>
        </div>
      ) : null}
    </section>
  )
}
