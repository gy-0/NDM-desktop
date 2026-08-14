import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Film, Folder, Settings2 } from 'lucide-react'
import { addFromUrl, chooseFolder, getEngineSettings, probeMedia, readClipboard } from '../lib/store'
import type { MediaFormat } from '../lib/types'

export function Composer({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [url, setUrl] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [filename, setFilename] = useState('')
  const [connections, setConnections] = useState<number>(16)
  const [showOptions, setShowOptions] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [mediaTitle, setMediaTitle] = useState<string | null>(null)
  const [mediaFormats, setMediaFormats] = useState<MediaFormat[]>([])
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setUrl('')
      setFilename('')
      setErrorMsg(null)
      setShowOptions(false)
      setMediaTitle(null)
      setMediaFormats([])
      setSelectedFormat(null)
      return
    }

    // Auto-detect clipboard URL
    void readClipboard().then((clip) => {
      const trimmed = clip?.trim() ?? ''
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ftp://')) {
        setUrl(trimmed)
      }
    })

    // Load default download directory and connections from engine
    void getEngineSettings().then((settings) => {
      if (settings?.downloadDirectory) setFolderPath(settings.downloadDirectory)
      if (settings?.maxConnections) setConnections(settings.maxConnections)
    })
  }, [open])

  // Probe media metadata when URL looks like video
  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed || !trimmed.startsWith('http')) return
    const isVideoSite = /youtube\.com|youtu\.be|bilibili\.com|twitter\.com|x\.com|vimeo\.com|tiktok\.com|m3u8/i.test(trimmed)
    if (isVideoSite) {
      void probeMedia(trimmed).then((res) => {
        if (res && res.formats && res.formats.length > 0) {
          setMediaTitle(res.title || null)
          setMediaFormats(res.formats)
          if (!filename && res.title) setFilename(res.title)
        }
      })
    }
  }, [url])

  if (!open) return null

  const handleChooseFolder = async (): Promise<void> => {
    const selected = await chooseFolder(folderPath)
    if (selected) setFolderPath(selected)
  }

  const submit = (): void => {
    const trimmed = url.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setErrorMsg(null)

    void addFromUrl({
      url: trimmed,
      folderPath: folderPath.trim() || undefined,
      filename: filename.trim() || undefined,
      connections: connections || undefined
    })
      .then((task) => {
        setSubmitting(false)
        setUrl('')
        onCreated(task.id)
        onClose()
      })
      .catch((error: unknown) => {
        setSubmitting(false)
        setErrorMsg(error instanceof Error ? error.message : '添加失败')
      })
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 px-6 pb-6" style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <form
        className="rounded-2xl border border-line-strong bg-raised/98 p-4 shadow-[0_20px_60px_rgb(0_0_0/0.45)] backdrop-blur-md"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">添加下载任务</div>
          <button
            type="button"
            onClick={() => setShowOptions(!showOptions)}
            className="flex items-center gap-1 text-[11.5px] text-mist transition-colors duration-150 hover:text-paper"
          >
            <Settings2 size={12} />
            <span>选项</span>
            {showOptions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        <input
          autoFocus
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setErrorMsg(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
          placeholder="粘贴 HTTP / HTTPS / FTP / 视频下载链接..."
          className="mt-3 w-full bg-transparent font-sans text-[18px] text-paper outline-none placeholder:text-mist/70"
          spellCheck={false}
        />

        {mediaFormats.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-copper/30 bg-copper/5 p-2" style={{ animation: 'fade-up 200ms ease both' }}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-copper">
              <Film size={12} />
              <span>检测到媒体解析：</span>
            </div>
            {mediaFormats.slice(0, 5).map((fmt) => (
              <button
                key={fmt.id}
                type="button"
                onClick={() => {
                  setSelectedFormat(fmt.id)
                  if (!filename && mediaTitle) setFilename(`${mediaTitle}.${fmt.containerHint.toLowerCase()}`)
                }}
                className={`rounded px-2 py-0.5 text-[10.5px] transition-colors ${
                  selectedFormat === fmt.id
                    ? 'bg-copper text-on-accent font-medium'
                    : 'border border-line/60 bg-panel/80 text-mist hover:text-paper'
                }`}
              >
                {fmt.label} ({fmt.containerHint})
              </button>
            ))}
          </div>
        ) : null}

        {showOptions ? (
          <div className="mt-3 space-y-2.5 border-t border-line/60 pt-3 text-[12.5px]" style={{ animation: 'fade-up 200ms ease both' }}>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-mist">保存目录</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-panel/60 px-2.5 py-1">
                <Folder size={13} className="shrink-0 text-mist" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fog" title={folderPath}>
                  {folderPath || '默认下载目录'}
                </span>
                <button
                  type="button"
                  onClick={handleChooseFolder}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-copper transition-colors hover:bg-line"
                >
                  浏览
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-mist">重命名</span>
              <input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="留空自动识别文件名"
                className="flex-1 rounded-lg border border-line bg-panel/60 px-2.5 py-1 font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/60"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-mist">分段连接</span>
              <div className="flex items-center gap-1.5">
                {[4, 8, 16, 32].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setConnections(num)}
                    className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                      connections === num ? 'border-copper bg-copper/15 text-copper' : 'border-line text-mist hover:text-paper'
                    }`}
                  >
                    {num} 线程
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="mt-2 text-[12px] text-clay">{errorMsg}</div>
        ) : null}

        <div className="mt-4 flex items-center justify-between border-t border-line/50 pt-3 text-[12px] text-mist">
          <span>回车确认 · Esc 取消</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3 py-1 text-[12px] text-mist transition-colors hover:text-paper"
            >
              取消
            </button>
            <button
              type="submit"
              data-cuelume-press
              data-cuelume-release
              className="rounded-full bg-copper px-4 py-1.5 font-medium text-on-accent transition-transform duration-150 active:scale-[0.96] disabled:opacity-50"
              disabled={!url.trim() || submitting}
            >
              {submitting ? '正在添加...' : '开始下载'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

