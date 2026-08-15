import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Film, Folder, HardDrive, Link2, Settings2, TriangleAlert } from 'lucide-react'
import { addFromUrl, checkStorage, chooseFolder, getEngineSettings, openExternal, probeMedia, readClipboard } from '../lib/store'
import { formatBytes } from '../lib/format'
import { extractSharedLinks, resolveSharedLink, sharedLinkSourceLabel, type SharedLinkSource } from '../lib/sharedLink'
import { cue } from '../lib/sound'
import type { MediaFormat, MediaProbeResult, StorageConfidenceResult, Task } from '../lib/types'
import { LoadingMark } from './LoadingMark'

function isDownloadableUrl(text: string): boolean {
  return resolveSharedLink(text) !== null
}

function siteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host.includes('youtube.com') || host === 'youtu.be') return 'YouTube'
    if (host.includes('bilibili.com')) return '哔哩哔哩'
    if (host.includes('vimeo.com')) return 'Vimeo'
    if (host.includes('tiktok.com')) return 'TikTok'
    if (host.includes('douyin.com') || host.includes('iesdouyin.com')) return '抖音'
    if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) return '小红书'
    if (host.includes('kuaishou.com')) return '快手'
    if (host.includes('weibo.com') || host.includes('weibo.cn')) return '微博'
    if (host.includes('instagram.com')) return 'Instagram'
    if (host.includes('facebook.com') || host === 'fb.watch') return 'Facebook'
    if (host.includes('twitch.tv')) return 'Twitch'
    if (host.includes('dailymotion.com') || host === 'dai.ly') return 'Dailymotion'
    if (host === 'x.com' || host.includes('twitter.com')) return 'X'
    return host
  } catch {
    return '网页媒体'
  }
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function SiteLogo({ url }: { url: string }) {
  const name = siteName(url)
  if (name === 'YouTube') {
    return (
      <svg aria-label="YouTube" viewBox="0 0 28 20" className="h-[14px] w-[20px]" role="img">
        <path fill="#FF0033" d="M27.4 3.1A3.5 3.5 0 0 0 25 0.7C22.9 0.1 14 0.1 14 0.1S5.1 0.1 3 0.7A3.5 3.5 0 0 0 0.6 3.1C0 5.2 0 10 0 10s0 4.8.6 6.9A3.5 3.5 0 0 0 3 19.3c2.1.6 11 .6 11 .6s8.9 0 11-.6a3.5 3.5 0 0 0 2.4-2.4c.6-2.1.6-6.9.6-6.9s0-4.8-.6-6.9Z" />
        <path fill="white" d="m11.2 14.2 7.3-4.2-7.3-4.2v8.4Z" />
      </svg>
    )
  }
  if (name === '哔哩哔哩') {
    return (
      <svg aria-label="哔哩哔哩" viewBox="0 0 24 24" className="size-[16px] text-[#00A1D6]" role="img">
        <path fill="currentColor" d="M7.4 2.3a.8.8 0 0 1 1.1.1L10 4h4l1.5-1.6a.8.8 0 1 1 1.2 1.1L16.2 4H18a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4h1.8l-.5-.5a.8.8 0 0 1 .1-1.2ZM6 6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H6Zm2.5 4A1.5 1.5 0 1 1 7 11.5 1.5 1.5 0 0 1 8.5 10Zm7 0a1.5 1.5 0 1 1-1.5 1.5 1.5 1.5 0 0 1 1.5-1.5Z" />
      </svg>
    )
  }
  return (
    <svg aria-label={name} viewBox="0 0 24 24" className="size-[15px] text-copper" role="img">
      <path fill="none" stroke="currentColor" strokeWidth="1.7" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.2-2.4 3.3-5.4 3.3-9S14.2 5.4 12 3m0 18c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3M3.5 9h17m-17 6h17" />
    </svg>
  )
}

export function Composer({
  open,
  initialUrl,
  onClose,
  onCreated
}: {
  open: boolean
  initialUrl?: string | null
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
  const [probing, setProbing] = useState(false)
  const [mediaTitle, setMediaTitle] = useState<string | null>(null)
  const [mediaFormats, setMediaFormats] = useState<MediaFormat[]>([])
  const [mediaThumbnail, setMediaThumbnail] = useState<string | null>(null)
  const [mediaThumbnailURL, setMediaThumbnailURL] = useState<string | null>(null)
  const [mediaDuration, setMediaDuration] = useState(0)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probeIssue, setProbeIssue] = useState<MediaProbeResult['errorKind']>()
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null)
  const [storageConfidence, setStorageConfidence] = useState<StorageConfidenceResult | null>(null)
  const [sharedSource, setSharedSource] = useState<SharedLinkSource | null>(null)
  const probeSeq = useRef(0)

  useEffect(() => {
    if (!open) {
      setUrl('')
      setFilename('')
      setErrorMsg(null)
      setShowOptions(false)
      setProbing(false)
      setMediaTitle(null)
      setMediaFormats([])
      setMediaThumbnail(null)
      setMediaThumbnailURL(null)
      setMediaDuration(0)
      setProbeError(null)
      setProbeIssue(undefined)
      setSelectedFormat(null)
      setStorageConfidence(null)
      setSharedSource(null)
      return
    }

    if (initialUrl && isDownloadableUrl(initialUrl)) {
      const resolution = resolveSharedLink(initialUrl)
      if (resolution) {
        setUrl(resolution.urlString)
        setSharedSource(resolution.wasExtractedFromText ? resolution.source : null)
      }
    } else {
      // Auto-detect clipboard URL
      void readClipboard().then((clip) => {
        const trimmed = clip?.trim() ?? ''
        const resolution = resolveSharedLink(trimmed)
        if (resolution) {
          setUrl((current) => current || resolution.urlString)
          setSharedSource(resolution.wasExtractedFromText ? resolution.source : null)
        }
      })
    }

    // Load default download directory and connections from engine
    void getEngineSettings().then((settings) => {
      if (settings?.downloadDirectory) setFolderPath(settings.downloadDirectory)
      if (settings?.maxConnections) setConnections(settings.maxConnections)
    })
  }, [open, initialUrl])

  // Probe media metadata when URL looks like video (debounced, latest wins)
  useEffect(() => {
    const trimmed = url.trim()
    setMediaTitle(null)
    setMediaFormats([])
    setMediaThumbnail(null)
    setMediaThumbnailURL(null)
    setMediaDuration(0)
    setProbeError(null)
    setProbeIssue(undefined)
    setSelectedFormat(null)
    const isVideoSite =
      /^https?:\/\//i.test(trimmed) &&
      /youtube\.com|youtu\.be|bilibili\.com|twitter\.com|x\.com|vimeo\.com|tiktok\.com|douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|kuaishou\.com|weibo\.(?:com|cn)|instagram\.com|facebook\.com|fb\.watch|twitch\.tv|dailymotion\.com|dai\.ly|m3u8/i.test(trimmed)
    if (!isVideoSite) {
      setProbing(false)
      return
    }
    const seq = ++probeSeq.current
    const timer = setTimeout(() => {
      setProbing(true)
      void probeMedia(trimmed).then((res) => {
        if (probeSeq.current !== seq) return
        setProbing(false)
        if (res && res.formats && res.formats.length > 0) {
          setMediaTitle(res.title || null)
          setMediaFormats(res.formats)
          if (res.thumbnailURL) {
            setMediaThumbnailURL(res.thumbnailURL)
            void window.ndm?.loadThumbnail(res.thumbnailURL)
              .then((thumbnail) => {
                if (probeSeq.current === seq && thumbnail) setMediaThumbnail(thumbnail)
              })
              .catch(() => undefined)
          }
          setMediaDuration(res.duration || 0)
          const preferred = res.formats[0]
          setSelectedFormat(preferred.id)
          setFilename((current) => current || (res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : ''))
        } else if (res?.errorKind === 'browserSessionRequired') {
          setProbeIssue(res.errorKind)
          setProbeError('这个网站需要刚刚访问过的浏览器会话。你可以授权 NDM 使用 Chrome 会话重试。')
        } else if (res?.errorKind === 'browserDataUnavailable') {
          setProbeIssue(res.errorKind)
          setProbeError('暂时无法读取浏览器会话。请从视频网页点击“通过 NDM 下载”，或稍后重试。')
        } else {
          setProbeIssue(res?.errorKind)
          setProbeError('暂时没有解析到可下载的清晰度，请检查网络后重试。')
        }
      })
    }, 250)
    return () => {
      clearTimeout(timer)
      if (probeSeq.current === seq) setProbing(false)
    }
  }, [url])

  useEffect(() => {
    const format = mediaFormats.find((item) => item.id === selectedFormat)
    if (!format || format.approximateBytes <= 0 || !folderPath) {
      setStorageConfidence(null)
      return
    }
    let current = true
    void checkStorage(folderPath, format)
      .then((result) => { if (current) setStorageConfidence(result) })
      .catch(() => { if (current) setStorageConfidence(null) })
    return () => { current = false }
  }, [folderPath, mediaFormats, selectedFormat])

  if (!open) return null

  const retryWithChrome = (): void => {
    const target = url.trim()
    if (!target || probing) return
    const seq = ++probeSeq.current
    setProbing(true)
    setProbeError(null)
    setProbeIssue(undefined)
    void probeMedia(target, 'chrome').then((res) => {
      if (probeSeq.current !== seq) return
      setProbing(false)
      if (res && res.formats.length > 0) {
        setMediaTitle(res.title || null)
        setMediaFormats(res.formats)
        setMediaDuration(res.duration || 0)
        const preferred = res.formats[0]
        setSelectedFormat(preferred.id)
        setFilename((current) => current || (res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : ''))
        if (res.thumbnailURL) {
          setMediaThumbnailURL(res.thumbnailURL)
          void window.ndm?.loadThumbnail(res.thumbnailURL).then((thumbnail) => {
            if (probeSeq.current === seq && thumbnail) setMediaThumbnail(thumbnail)
          })
        }
        cue('success')
      } else if (res?.errorKind === 'browserDataUnavailable') {
        setProbeIssue(res.errorKind)
        setProbeError('Chrome 会话暂时无法读取。请从视频网页点击“通过 NDM 下载”。')
      } else {
        setProbeIssue(res?.errorKind)
        setProbeError('浏览器会话仍不足以解析这个视频，请先在 Chrome 中打开并刷新视频页面。')
      }
    })
  }

  const handleChooseFolder = async (): Promise<void> => {
    const selected = await chooseFolder(folderPath)
    if (selected) setFolderPath(selected)
  }

  const baseOptions = (): { folderPath?: string; connections?: number } => ({
    folderPath: folderPath.trim() || undefined,
    connections: connections || undefined
  })

  // Pasting a list of links queues every one of them at once.
  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    const resolutions = extractSharedLinks(text)
    if (resolutions.length === 0 || submitting) return
    event.preventDefault()
    if (resolutions.length === 1) {
      const resolution = resolutions[0]
      setUrl(resolution.urlString)
      setSharedSource(resolution.wasExtractedFromText ? resolution.source : null)
      cue('tick')
      return
    }
    setSubmitting(true)
    setErrorMsg(null)
    void (async () => {
      let lastTask: Task | null = null
      let failures = 0
      for (const item of resolutions) {
        try {
          lastTask = await addFromUrl({ url: item.urlString, ...baseOptions() })
        } catch {
          failures += 1
        }
      }
      setSubmitting(false)
      if (lastTask) {
        onCreated(lastTask.id)
        onClose()
      } else if (failures > 0) {
        setErrorMsg(`批量添加失败（${failures} 条链接均未成功）`)
      }
    })()
  }

  const submit = (): void => {
    const trimmed = resolveSharedLink(url)?.urlString ?? url.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setErrorMsg(null)

    void addFromUrl({
      url: trimmed,
      ...baseOptions(),
      filename: filename.trim() || undefined,
      formatID: selectedFormat || undefined,
      pageTitle: mediaTitle || undefined,
      thumbnailURL: mediaThumbnailURL || undefined
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
            setSharedSource(null)
            setErrorMsg(null)
          }}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
          placeholder="粘贴下载链接或整段分享口令..."
          className="mt-3 w-full bg-transparent font-sans text-[18px] text-paper outline-none placeholder:text-mist/70"
          spellCheck={false}
        />

        {sharedSource ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-copper">
            <Link2 size={11} strokeWidth={1.7} />
            已从{sharedLinkSourceLabel(sharedSource)}分享口令中提取链接
          </div>
        ) : null}

        {probing || mediaFormats.length > 0 || probeError ? (
          <div className="mt-3 overflow-hidden rounded-[14px] border border-line-strong bg-panel/78" style={{ animation: 'fade-up 220ms cubic-bezier(0.23,1,0.32,1) both' }}>
            <div className="flex gap-3 p-3">
              <div className="relative grid h-[94px] w-[168px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-ink/55 shadow-[inset_0_0_0_1px_var(--line)]">
                {mediaThumbnail ? (
                  <img src={mediaThumbnail} alt="视频缩略图" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <Film size={26} strokeWidth={1.25} className="text-mist" />
                )}
                {probing ? <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" /> : null}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <div className="flex items-center gap-2 text-[11px] text-mist">
                  <SiteLogo url={url} />
                  <span>{siteName(url)}</span>
                  {mediaDuration > 0 ? <span className="font-mono">{formatDuration(mediaDuration)}</span> : null}
                </div>
                <h3 className="mt-2 line-clamp-2 font-serif text-[18px] leading-snug text-paper">
                  {mediaTitle || (probing ? '正在读取视频信息…' : '网页视频')}
                </h3>
                {probing ? <div className="mt-2"><LoadingMark label="正在解析清晰度与音视频轨…" /></div> : null}
                {probeError ? (
                  <div className="mt-2">
                    <p className="text-[11.5px] leading-relaxed text-clay">{probeError}</p>
                    <div className="mt-2 flex items-center gap-1.5">
                      {probeIssue === 'browserSessionRequired' ? (
                        <button
                          type="button"
                          onClick={retryWithChrome}
                          className="h-7 rounded-[8px] bg-copper px-2.5 text-[10.5px] font-medium text-on-accent transition-[filter,scale] duration-100 active:scale-[0.96]"
                        >
                          使用 Chrome 会话重试
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void openExternal(url)}
                        className="h-7 rounded-[8px] px-2.5 text-[10.5px] text-fog shadow-[inset_0_0_0_1px_var(--line)] transition-[color,scale] duration-100 active:scale-[0.96]"
                      >
                        在浏览器中打开
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {mediaFormats.length > 0 ? (
              <div className="border-t border-line/70 p-3">
                <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-mist">选择清晰度</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {mediaFormats.slice(0, 6).map((fmt) => (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => {
                        setSelectedFormat(fmt.id)
                        if (mediaTitle) setFilename(`${mediaTitle}.${fmt.containerHint.toLowerCase()}`)
                      }}
                      className={`flex min-w-0 items-center justify-between rounded-[9px] border px-2.5 py-2 text-left transition-[color,background-color,border-color,scale] duration-100 active:scale-[0.96] ${
                        selectedFormat === fmt.id
                          ? 'border-copper/65 bg-copper/14 text-paper'
                          : 'border-line bg-ink/20 text-fog hover:border-line-strong hover:bg-raised/70'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[11.5px] font-medium">{fmt.label}</span>
                        <span className="mt-0.5 block font-mono text-[9.5px] text-mist">
                          {fmt.containerHint.toUpperCase()}{fmt.approximateBytes > 0 ? ` · ${formatBytes(fmt.approximateBytes)}` : ''}
                        </span>
                      </span>
                      {selectedFormat === fmt.id ? <Check size={13} className="shrink-0 text-copper" /> : null}
                    </button>
                  ))}
                </div>
                {storageConfidence && storageConfidence.level !== 'unknown' ? (
                  <div className={`mt-2 flex items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-[10.5px] ${
                    storageConfidence.level === 'comfortable'
                      ? 'bg-sage/10 text-sage'
                      : 'bg-clay/10 text-clay'
                  }`}>
                    {storageConfidence.level === 'comfortable' ? <HardDrive size={12} /> : <TriangleAlert size={12} />}
                    <span>
                      {storageConfidence.level === 'comfortable'
                        ? `预计峰值 ${formatBytes(storageConfidence.peakBytes)} · 完成后仍有 ${formatBytes(storageConfidence.projectedFreeBytes)} 可用`
                        : storageConfidence.level === 'tight'
                          ? `空间较紧 · 预计完成后仅剩 ${formatBytes(storageConfidence.projectedFreeBytes)}`
                          : `空间不足 · 还需要 ${formatBytes(storageConfidence.shortfallBytes)}`}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
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
          <span>回车确认 · Esc 取消 · 支持一次粘贴多条链接</span>
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
              disabled={!url.trim() || submitting || storageConfidence?.level === 'insufficient'}
            >
              {submitting ? '正在添加...' : '开始下载'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
