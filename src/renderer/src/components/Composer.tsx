import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, ChevronDown, ChevronUp, Crown, Film, Folder, HardDrive, Link2, Settings2, TriangleAlert } from 'lucide-react'
import { addFromUrl, addMedia, checkStorage, chooseFolder, findDuplicate, getEngineSettings, openExternal, probeMedia, readClipboard } from '../lib/store'
import { formatBytes, looksLikeOrdinaryFileDownload } from '../lib/format'
import { extractSharedLinks, resolveSharedLink, sharedLinkSourceLabel, type SharedLinkSource } from '../lib/sharedLink'
import { cue } from '../lib/sound'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { requiresPro, useIsPro } from '../lib/license'
import { STATUS_LABEL } from '../lib/types'
import type {
  MediaCollectionScope,
  MediaCollectionSummary,
  MediaContainerPreference,
  MediaFormat,
  MediaProbeResult,
  MediaSubtitleTrack,
  StorageConfidenceResult,
  Task
} from '../lib/types'
import { LoadingMark } from './LoadingMark'
import { ProChip } from './ProChip'

/** 2160p and above remains the current draft boundary for future Pro work. */
function isUltraHD(format: MediaFormat): boolean {
  return format.height >= 2160
}

function isDownloadableUrl(text: string): boolean {
  return resolveSharedLink(text) !== null
}

function siteName(url: string): string {
  try {
    if (url.startsWith('magnet:')) return 'BT 磁力链'
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

function estimatedBytes(format: MediaFormat, container: MediaContainerPreference): number {
  return container === 'compactMKV' ? format.compactApproximateBytes : format.approximateBytes
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
  onCreated,
  onShowExisting,
  onUpgrade
}: {
  open: boolean
  initialUrl?: string | null
  onClose: () => void
  onCreated: (id: number, count?: number) => void
  onShowExisting: (id: number) => void
  onUpgrade: (reason: string) => void
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
  const [mediaSubtitles, setMediaSubtitles] = useState<MediaSubtitleTrack[]>([])
  const [selectedSubtitle, setSelectedSubtitle] = useState<string | null>(null)
  const [mediaCollection, setMediaCollection] = useState<MediaCollectionSummary | null>(null)
  const [collectionScope, setCollectionScope] = useState<MediaCollectionScope>('current')
  const [container, setContainer] = useState<MediaContainerPreference>('compatibleMP4')
  const [mediaCookieBrowser, setMediaCookieBrowser] = useState<string | null>(null)
  const [storageConfidence, setStorageConfidence] = useState<StorageConfidenceResult | null>(null)
  const [sharedSource, setSharedSource] = useState<SharedLinkSource | null>(null)
  const [duplicateCurrent, setDuplicateCurrent] = useState<Task | null>(null)
  const [duplicateCollection, setDuplicateCollection] = useState<Task | null>(null)
  const probeSeq = useRef(0)
  const duplicateSeq = useRef(0)
  const pro = useIsPro()
  const proRef = useRef(pro)
  proRef.current = pro

  const preferredFormat = (formats: MediaFormat[]): MediaFormat =>
    (!COMMERCIALIZATION_DRAFT_ENABLED || proRef.current
      ? formats[0]
      : formats.find((item) => !isUltraHD(item))) ?? formats[0]

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
      setMediaSubtitles([])
      setSelectedSubtitle(null)
      setMediaCollection(null)
      setCollectionScope('current')
      setContainer('compatibleMP4')
      setMediaCookieBrowser(null)
      setStorageConfidence(null)
      setSharedSource(null)
      setDuplicateCurrent(null)
      setDuplicateCollection(null)
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

    // The window can become interactive a few milliseconds before the Host
    // socket accepts its first request. Retry this small startup read instead
    // of silently losing the destination and therefore Space Confidence.
    let settingsTimer: ReturnType<typeof setTimeout> | undefined
    let current = true
    const loadSettings = (attempt: number): void => {
      void getEngineSettings()
        .then((settings) => {
          if (!current) return
          if (settings?.downloadDirectory) setFolderPath(settings.downloadDirectory)
          if (settings?.maxConnections) setConnections(settings.maxConnections)
        })
        .catch(() => {
          if (current && attempt < 3) settingsTimer = setTimeout(() => loadSettings(attempt + 1), 400)
        })
    }
    loadSettings(0)
    return () => {
      current = false
      if (settingsTimer) clearTimeout(settingsTimer)
    }
  }, [open, initialUrl])

  // Probe media metadata when URL looks like video (debounced, latest wins)
  useEffect(() => {
    const trimmed = url.trim()
    const seq = ++probeSeq.current
    const duplicateRequest = ++duplicateSeq.current
    setMediaTitle(null)
    setMediaFormats([])
    setMediaThumbnail(null)
    setMediaThumbnailURL(null)
    setMediaDuration(0)
    setProbeError(null)
    setProbeIssue(undefined)
    setSelectedFormat(null)
    setMediaSubtitles([])
    setSelectedSubtitle(null)
    setMediaCollection(null)
    setCollectionScope('current')
    setContainer('compatibleMP4')
    setMediaCookieBrowser(null)
    setDuplicateCurrent(null)
    setDuplicateCollection(null)
    const shouldProbe =
      /^https?:\/\//i.test(trimmed) && !looksLikeOrdinaryFileDownload(trimmed)
    if (!shouldProbe) {
      setProbing(false)
      if (!/^https?:\/\//i.test(trimmed)) return
      const duplicateTimer = setTimeout(() => {
        void findDuplicate([trimmed]).then((match) => {
          if (duplicateSeq.current === duplicateRequest) setDuplicateCurrent(match)
        })
      }, 120)
      return () => clearTimeout(duplicateTimer)
    }
    const timer = setTimeout(() => {
      setProbing(true)
      void probeMedia(trimmed).then((res) => {
        if (probeSeq.current !== seq) return
        setProbing(false)
        if (res && res.formats && res.formats.length > 0) {
          setMediaTitle(res.title || null)
          setMediaFormats(res.formats)
          setMediaSubtitles(res.subtitles)
          setMediaCollection(res.collection ?? null)
          setDuplicateCurrent(res.duplicateCurrent ?? null)
          setDuplicateCollection(res.duplicateCollection ?? null)
          const thumbnailURL = res.thumbnailURL || res.collection?.thumbnailURL
          if (thumbnailURL) {
            setMediaThumbnailURL(thumbnailURL)
            void window.ndm?.loadThumbnail(thumbnailURL)
              .then((thumbnail) => {
                if (probeSeq.current === seq && thumbnail) setMediaThumbnail(thumbnail)
              })
              .catch(() => undefined)
          }
          setMediaDuration(res.duration || 0)
          const preferred = preferredFormat(res.formats)
          setSelectedFormat(preferred.id)
          setFilename((current) => current || (res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : ''))
        } else if (res?.errorKind === 'browserSessionRequired') {
          setProbeIssue(res.errorKind)
          setProbeError('这个网站需要刚刚访问过的浏览器会话。你可以授权 NDM 使用 Chrome 会话重试。')
        } else if (res?.errorKind === 'browserDataUnavailable') {
          setProbeIssue(res.errorKind)
          setProbeError('暂时无法读取浏览器会话。请从视频网页点击“通过 NDM 下载”，或稍后重试。')
        } else {
          // Not every https page is a video. Fall back to the Neat file engine.
          setProbeIssue(undefined)
          setProbeError(null)
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
    if (!format || estimatedBytes(format, container) <= 0 || !folderPath) {
      setStorageConfidence(null)
      return
    }
    let current = true
    void checkStorage(folderPath, format, {
      url: url.trim(),
      collectionScope,
      container
    })
      .then((result) => { if (current) setStorageConfidence(result) })
      .catch(() => { if (current) setStorageConfidence(null) })
    return () => { current = false }
  }, [collectionScope, container, folderPath, mediaFormats, selectedFormat, url])

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
        setMediaSubtitles(res.subtitles)
        setMediaCollection(res.collection ?? null)
        setDuplicateCurrent(res.duplicateCurrent ?? null)
        setDuplicateCollection(res.duplicateCollection ?? null)
        setMediaCookieBrowser('chrome')
        setMediaDuration(res.duration || 0)
        const preferred = preferredFormat(res.formats)
        setSelectedFormat(preferred.id)
        setFilename((current) => current || (res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : ''))
        const thumbnailURL = res.thumbnailURL || res.collection?.thumbnailURL
        if (thumbnailURL) {
          setMediaThumbnailURL(thumbnailURL)
          void window.ndm?.loadThumbnail(thumbnailURL).then((thumbnail) => {
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
    if (COMMERCIALIZATION_DRAFT_ENABLED && collectionScope === 'all' && requiresPro('playlist')) {
      onUpgrade('整批下载播放列表与频道')
      return
    }
    setSubmitting(true)
    setErrorMsg(null)

    const creation = selectedFormat && mediaFormats.length > 0
      ? addMedia({
          url: trimmed,
          folderPath: folderPath.trim() || undefined,
          filename: collectionScope === 'all' ? undefined : (filename.trim() || undefined),
          formatID: selectedFormat,
          container,
          subtitleLanguage: selectedSubtitle || undefined,
          collectionScope,
          cookieBrowser: mediaCookieBrowser || undefined
        })
      : addFromUrl({
          url: trimmed,
          ...baseOptions(),
          filename: filename.trim() || undefined,
          formatID: selectedFormat || undefined,
          pageTitle: mediaTitle || undefined,
          thumbnailURL: mediaThumbnailURL || undefined
        }).then((task) => ({ task, count: 1 }))

    void creation
      .then(({ task, count }) => {
        setSubmitting(false)
        setUrl('')
        onCreated(task.id, count)
        onClose()
      })
      .catch((error: unknown) => {
        setSubmitting(false)
        setErrorMsg(error instanceof Error ? error.message : '添加失败')
      })
  }

  const duplicate = collectionScope === 'all' ? duplicateCollection : duplicateCurrent

  return (
    <>
      {/* Gentle scrim so the composer owns attention; clicking it dismisses,
          matching every other sheet in the app. */}
      <div
        aria-hidden
        className="absolute inset-0 z-10 bg-ink/25"
        style={{ animation: 'fade-in 200ms ease both' }}
        onClick={onClose}
      />
      <div
        className="absolute inset-x-0 bottom-0 z-20 px-6 pb-6"
        style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <form
          className="max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-line-strong bg-raised/98 p-4 shadow-[0_20px_60px_rgb(0_0_0/0.45)] backdrop-blur-md scroll-quiet"
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
          placeholder="粘贴下载链接、磁力链或整段分享口令..."
          className="mt-3 w-full bg-transparent font-sans text-[18px] text-paper outline-none placeholder:text-mist/70"
          spellCheck={false}
        />

        {sharedSource ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-copper">
            <Link2 size={11} strokeWidth={1.7} />
            已从{sharedLinkSourceLabel(sharedSource)}分享口令中提取链接
          </div>
        ) : null}

        {duplicate ? (
          <div className="mt-3 flex items-center gap-2.5 rounded-[11px] bg-sage/9 px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ok)_22%,transparent)]">
            <CheckCircle2 size={16} strokeWidth={1.7} className="shrink-0 text-sage" />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-medium text-paper">这项内容已经在下载列表中</p>
              <p className="mt-0.5 truncate text-[10.5px] text-mist">
                {duplicate.filename || duplicate.title} · {STATUS_LABEL[duplicate.status]}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                onShowExisting(duplicate.id)
                onClose()
              }}
              className="shrink-0 rounded-[7px] px-2.5 py-1 text-[10.5px] font-medium text-sage shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ok)_28%,transparent)] transition-[background-color,scale] duration-100 hover:bg-sage/10 active:scale-[0.96]"
            >
              查看已有
            </button>
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
                {mediaCollection ? (
                  <div className="mb-3 rounded-[10px] bg-ink/25 p-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] font-medium text-paper">{mediaCollection.title || '视频合集'}</p>
                        <p className="mt-0.5 text-[10px] text-mist">
                          已识别 {mediaCollection.itemCount} 项{mediaCollection.isTruncated ? ` · 本次最多处理前 ${mediaCollection.availableItemCount} 项` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {COMMERCIALIZATION_DRAFT_ENABLED && requiresPro('playlist') ? (
                          <ProChip onClick={() => onUpgrade('整批下载播放列表与频道')} title="整批下载是 Pro 能力" />
                        ) : null}
                        <div className="flex rounded-[8px] bg-panel/75 p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
                          <button
                            type="button"
                            onClick={() => setCollectionScope('current')}
                            className={`rounded-[6px] px-2.5 py-1 text-[10.5px] transition-[color,background-color,scale] duration-100 active:scale-[0.96] ${collectionScope === 'current' ? 'bg-raised text-paper shadow-sm' : 'text-mist'}`}
                          >
                            当前视频
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (COMMERCIALIZATION_DRAFT_ENABLED && requiresPro('playlist')) {
                                onUpgrade('整批下载播放列表与频道')
                                return
                              }
                              setCollectionScope('all')
                            }}
                            className={`flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[10.5px] transition-[color,background-color,scale] duration-100 active:scale-[0.96] ${
                              collectionScope === 'all'
                                ? 'bg-raised text-paper shadow-sm'
                                : COMMERCIALIZATION_DRAFT_ENABLED && requiresPro('playlist')
                                  ? 'text-mist/70'
                                  : 'text-mist'
                            }`}
                          >
                            {mediaCollection.isTruncated ? `前 ${mediaCollection.availableItemCount} 项` : `整个合集 · ${mediaCollection.itemCount}`}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-mist">选择清晰度</span>
                  {COMMERCIALIZATION_DRAFT_ENABLED && requiresPro('ultraHD') && mediaFormats.some(isUltraHD) ? (
                    <ProChip label="4K / 8K" onClick={() => onUpgrade('4K / 8K 超清下载')} title="超清轨是 Pro 能力" />
                  ) : null}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {mediaFormats.slice(0, 6).map((fmt) => {
                    const locked = COMMERCIALIZATION_DRAFT_ENABLED && isUltraHD(fmt) && requiresPro('ultraHD')
                    return (
                      <button
                        key={fmt.id}
                        type="button"
                        onClick={() => {
                          if (locked) {
                            onUpgrade('4K / 8K 超清下载')
                            return
                          }
                          setSelectedFormat(fmt.id)
                          if (mediaTitle) setFilename(`${mediaTitle}.${container === 'compatibleMP4' ? 'mp4' : 'mkv'}`)
                        }}
                        className={`flex min-w-0 items-center justify-between rounded-[9px] border px-2.5 py-2 text-left transition-[color,background-color,border-color,scale] duration-100 active:scale-[0.96] ${
                          selectedFormat === fmt.id
                            ? 'border-copper/65 bg-copper/14 text-paper'
                            : locked
                              ? 'border-line bg-ink/12 text-mist hover:border-copper/40'
                              : 'border-line bg-ink/20 text-fog hover:border-line-strong hover:bg-raised/70'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[11.5px] font-medium">{fmt.label}</span>
                          <span className="mt-0.5 block font-mono text-[9.5px] text-mist">
                            {container === 'compatibleMP4' ? 'MP4' : 'MKV'}{estimatedBytes(fmt, container) > 0 ? ` · ${formatBytes(estimatedBytes(fmt, container))}` : ''}
                          </span>
                        </span>
                        {locked ? (
                          <Crown size={11} strokeWidth={2.2} className="shrink-0 text-copper/85" aria-label="Pro" />
                        ) : selectedFormat === fmt.id ? (
                          <Check size={13} className="shrink-0 text-copper" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line/60 pt-3">
                  <div>
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-mist">成品格式</div>
                    <div className="grid grid-cols-2 rounded-[9px] bg-ink/25 p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
                      {([
                        ['compatibleMP4', 'MP4', '兼容优先'],
                        ['compactMKV', 'MKV', '体积更小']
                      ] as const).map(([value, label, detail]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            setContainer(value)
                            if (mediaTitle) {
                              setFilename((current) => current === `${mediaTitle}.mp4` || current === `${mediaTitle}.mkv`
                                ? `${mediaTitle}.${value === 'compatibleMP4' ? 'mp4' : 'mkv'}`
                                : current)
                            }
                          }}
                          className={`rounded-[7px] px-2 py-1.5 text-left transition-[color,background-color,scale] duration-100 active:scale-[0.96] ${container === value ? 'bg-raised text-paper shadow-sm' : 'text-mist'}`}
                        >
                          <span className="block text-[10.5px] font-medium">{label}</span>
                          <span className="block text-[9.5px] opacity-70">{detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <label>
                    <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.1em] text-mist">字幕</span>
                    <span className="relative block">
                      <select
                        value={selectedSubtitle ?? ''}
                        onChange={(event) => setSelectedSubtitle(event.target.value || null)}
                        disabled={mediaSubtitles.length === 0}
                        className="h-[49px] w-full appearance-none rounded-[9px] bg-ink/25 px-2.5 pr-7 text-[10.5px] text-fog outline-none shadow-[inset_0_0_0_1px_var(--line)] focus:shadow-[inset_0_0_0_1px_var(--accent)] disabled:text-mist/60"
                      >
                        <option value="">{mediaSubtitles.length > 0 ? '不下载字幕' : '未检测到字幕'}</option>
                        {mediaSubtitles.map((track) => (
                          <option key={track.code} value={track.code}>
                            {track.displayName}{track.isAutomatic ? ' · 自动生成' : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-mist" />
                    </span>
                  </label>
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
                        ? `${storageConfidence.isCollectionEstimate ? '合集' : ''}预计峰值 ${formatBytes(storageConfidence.peakBytes)} · 完成后仍有 ${formatBytes(storageConfidence.projectedFreeBytes)} 可用`
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
          <span>回车确认 · Esc 取消 · 支持链接、磁力链与批量粘贴</span>
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
              {submitting
                ? '正在添加...'
                : duplicate
                  ? '仍要再下一份'
                  : collectionScope === 'all' && mediaCollection
                    ? `下载${mediaCollection.isTruncated ? `前 ${mediaCollection.availableItemCount} 项` : `整个合集 · ${mediaCollection.itemCount}`}`
                    : '开始下载'}
            </button>
          </div>
        </div>
      </form>
      </div>
    </>
  )
}
