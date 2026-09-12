import { Dialog } from '@base-ui/react/dialog'
import { readSessionBrowser } from '../lib/sessionPrefs'
import { mediaSessionBrowserOptions, initialMediaSessionBrowser, type MediaSessionBrowser } from '../lib/mediaSessionBrowser'
import { mediaAccessMessage, requiresResolvedMedia } from '../lib/mediaAccessFailure'
import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, LoaderCircle, Check, CheckCircle2, ChevronDown, ChevronUp, Crown, Film, Folder, HardDrive, Link2, Settings2, Sparkles, TriangleAlert } from 'lucide-react'
import { addFromUrl, addMedia, checkStorage, chooseFolder, findDuplicate, getEngineSettings, openExternal, probeMedia, readClipboard } from '../lib/store'
import { formatBytes, looksLikeOrdinaryFileDownload } from '../lib/format'
import { extractSharedLinks, isKnownMediaSiteURL, resolveSharedLink, sharedLinkSourceLabel, type SharedLinkSource } from '../lib/sharedLink'
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
import { SegmentedControl } from './SegmentedControl'
import { SquareChoice } from './SquareChoice'
import { CONNECTION_OPTIONS, IS_WINDOWS } from '../lib/platform'
import { appendBatchLinks, type ComposerBatchLink } from '../lib/composerBatch'
import { ComposerBatchReview } from './ComposerBatchReview'
import './ui/composer-media.css'

/** 2160p and above remains the current draft boundary for future Pro work. */
function isUltraHD(format: MediaFormat): boolean {
  return format.height >= 2160
}

function isHighBitrate(format: MediaFormat): boolean {
  return Boolean(format.isHighBitrate) || format.label.includes('高码率')
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
  onUpgrade,
  onClipboardConsumed
}: {
  open: boolean
  initialUrl?: string | null
  onClose: () => void
  onCreated: (id: number, count?: number) => void
  onShowExisting: (id: number) => void
  onUpgrade: (reason: string) => void
  onClipboardConsumed?: () => void
}) {
  const [url, setUrl] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [filename, setFilename] = useState('')
  const [connections, setConnections] = useState<number>(16)
  const [showOptions, setShowOptions] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [batchLinks, setBatchLinks] = useState<ComposerBatchLink[]>([])
  const [batchCompleted, setBatchCompleted] = useState(0)
  const [batchNotice, setBatchNotice] = useState<string | null>(null)
  const [batchStopping, setBatchStopping] = useState(false)
  const batchStopRequested = useRef(false)
  const acceptedBatchURLs = useRef(new Set<string>())
  const filenameEdited = useRef(false)
  const draftEdited = useRef(false)
  const batchMode = batchLinks.length > 0
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  const destinationSession = useRef(0)
  const folderChoice = useRef(0)
  const folderEdited = useRef(false)
  const connectionsEdited = useRef(false)
  if (open !== wasOpen.current) {
    destinationSession.current++
    folderChoice.current++
    folderEdited.current = false
    connectionsEdited.current = false
    filenameEdited.current = false
    draftEdited.current = false
    acceptedBatchURLs.current = new Set()
  }
  if (open && !wasOpen.current) previousFocus.current = document.activeElement as HTMLElement | null
  wasOpen.current = open
  const [mediaTitle, setMediaTitle] = useState<string | null>(null)
  const [availabilityNotice, setAvailabilityNotice] = useState<MediaProbeResult['availabilityNotice']>()
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
  const [probeNonce, setProbeNonce] = useState(0)
  const retryCookieBrowser = useRef<MediaSessionBrowser | null>(null)
  const [sessionBrowser, setSessionBrowser] = useState<MediaSessionBrowser | null>(() => initialMediaSessionBrowser(readSessionBrowser(), IS_WINDOWS))
  const browserOptions = mediaSessionBrowserOptions(IS_WINDOWS)
  const sessionBrowserLabel = browserOptions.find(option => option.value === sessionBrowser)?.label ?? '浏览器'
  const onClipboardConsumedRef = useRef(onClipboardConsumed)
  onClipboardConsumedRef.current = onClipboardConsumed
  const pro = useIsPro()
  const proRef = useRef(pro)
  proRef.current = pro

  const preferredFormat = (formats: MediaFormat[]): MediaFormat =>
    (!COMMERCIALIZATION_DRAFT_ENABLED || proRef.current
      ? formats[0]
      : formats.find((item) => !isUltraHD(item))) ?? formats[0]

  useEffect(() => {
    if (!open) {
      setSessionBrowser(initialMediaSessionBrowser(readSessionBrowser(), IS_WINDOWS))
      setUrl('')
      setFilename('')
      setFolderPath('')
      setConnections(16)
      setErrorMsg(null)
      setShowOptions(false)
      setSubmitting(false)
      setBatchLinks([])
      setBatchCompleted(0)
      setBatchNotice(null)
      setBatchStopping(false)
      batchStopRequested.current = false
      setProbing(false)
      setMediaTitle(null)
      setAvailabilityNotice(undefined)
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

    const session = destinationSession.current
    const prepare = (text: string): boolean => {
      if (destinationSession.current !== session) return false
      const resolutions = extractSharedLinks(text)
      if (resolutions.length > 1) {
        setBatchLinks(appendBatchLinks([], text))
        setUrl('')
        setSharedSource(null)
        return true
      }
      const resolution = resolutions[0]
      if (!resolution) return false
      setUrl((current) => current || resolution.urlString)
      setSharedSource(resolution.wasExtractedFromText ? resolution.source : null)
      return true
    }
    if (initialUrl && isDownloadableUrl(initialUrl)) prepare(initialUrl)
    else {
      void readClipboard().then((clip) => {
        // A slow clipboard response must not replace typing or a later dialog.
        if (destinationSession.current !== session || draftEdited.current || urlInputRef.current?.value) return
        if (prepare(clip?.trim() ?? '')) onClipboardConsumedRef.current?.()
      }).catch(() => undefined)
    }
  }, [open, initialUrl])

  useEffect(() => {
    if (!open || !submitting) return
    // A disabled submit control can leave focus on the document. Capture Esc
    // before the workspace shortcut so a pending request keeps its draft.
    const keepPendingDraft = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', keepPendingDraft, true)
    return () => window.removeEventListener('keydown', keepPendingDraft, true)
  }, [open, submitting])

  useEffect(() => {
    if (!open) return
    const session = destinationSession.current
    setFolderPath('')
    setConnections(16)
    // The window can become interactive a few milliseconds before the Host
    // socket accepts its first request. Retry this small startup read instead
    // of silently losing the destination and therefore Space Confidence.
    let settingsTimer: ReturnType<typeof setTimeout> | undefined
    let current = true
    const loadSettings = (attempt: number): void => {
      void getEngineSettings()
        .then((settings) => {
          if (!current || destinationSession.current !== session) return
          if (!folderEdited.current && settings?.downloadDirectory) setFolderPath(settings.downloadDirectory)
          if (!connectionsEdited.current && settings?.maxConnections) setConnections(settings.maxConnections)
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
  }, [open])

  // Probe media metadata when URL looks like video (debounced, latest wins)
  useEffect(() => {
    const trimmed = batchMode ? '' : url.trim()
    retryCookieBrowser.current = null
    const seq = ++probeSeq.current
    const duplicateRequest = ++duplicateSeq.current
    setMediaTitle(null)
    setAvailabilityNotice(undefined)
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
    const scheduleDuplicateCheck = (): number => {
      const duplicateTimer = setTimeout(() => {
        void findDuplicate([trimmed])
          .then((match) => {
            if (duplicateSeq.current === duplicateRequest) setDuplicateCurrent(match)
          })
          .catch(() => {
            if (duplicateSeq.current === duplicateRequest) setDuplicateCurrent(null)
          })
      }, 120)
      return duplicateTimer
    }
    if (!shouldProbe) {
      setProbing(false)
      if (!/^https?:\/\//i.test(trimmed)) return
      const duplicateTimer = scheduleDuplicateCheck()
      return () => clearTimeout(duplicateTimer)
    }
    // The server knows better than a filename heuristic: a HEAD that answers
    // with a file type means this paste is an ordinary download, and probing
    // it as video would just make the user wait through "检测视频清晰度".
    let classifyTimer: number | null = null
    void Promise.resolve().then(() => window.ndm?.classifyURL?.(trimmed)).catch(() => null).then((classified) => {
      if (probeSeq.current !== seq) return
      if (classified?.kind === 'binary') {
        classifyTimer = scheduleDuplicateCheck()
        return
      }
      // The classifier tried the browser session and the site still answered
      // with a page — tell the user before they commit a download that would
      // just save that login page.
      if (classified?.sessionNote) {
        setProbing(false)
        setProbeIssue('probeFailed')
        setProbeError(classified.sessionNote)
        return
      }
      classifyTimer = window.setTimeout(() => {
        setProbing(true)
        void probeMedia(trimmed).then((res) => {
        if (probeSeq.current !== seq) return
        setProbing(false)
        if (res && res.formats && res.formats.length > 0) {
          setAvailabilityNotice(res.availabilityNotice)
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
          if (!filenameEdited.current) setFilename(res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : '')
        } else if (mediaAccessMessage(res?.errorKind)) {
          setProbeIssue(res?.errorKind)
          setProbeError(mediaAccessMessage(res?.errorKind))
        } else if (res?.errorKind === 'browserSessionRequired') {
          setProbeIssue(res.errorKind)
          setProbeError('请在浏览器中确认可观看此视频，再重试。')
        } else if (res?.errorKind === 'browserDataUnavailable') {
          setProbeIssue(res.errorKind)
          setProbeError('无法读取浏览器登录信息。请选择其他浏览器重试。')
        } else {
          // Not every https page is a video. Fall back to the Neat file engine —
          // but a known media site's page is never an ordinary file: its HTML
          // fallback used to save the page itself as "video.mp4".
          if (isKnownMediaSiteURL(trimmed)) {
            setProbeIssue('probeFailed')
            setProbeError('视频暂时无法解析，请稍后重试。')
          } else {
            setProbeIssue(undefined)
            setProbeError(null)
          }
        }
      }).catch(() => {
        if (probeSeq.current !== seq) return
        setProbing(false)
        if (isKnownMediaSiteURL(trimmed)) {
          setProbeIssue('probeFailed')
          setProbeError(`未能解析${siteName(trimmed)}链接，请重试。`)
        } else {
          setProbeIssue(undefined)
          setProbeError('未能解析链接，请重试或选择普通下载。')
        }
      })
      }, 250)
    })
    return () => {
      if (classifyTimer !== null) clearTimeout(classifyTimer)
      if (probeSeq.current === seq) setProbing(false)
    }
  }, [url, probeNonce, batchMode])

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

  const unresolvedMedia = !batchMode && requiresResolvedMedia(url, selectedFormat)
  const deniedMedia = !batchMode && Boolean(mediaAccessMessage(probeIssue))
  const mediaSubmitBlocked = unresolvedMedia || deniedMedia
  const submissionHint = deniedMedia ? '暂不可下载，请查看上方提示。'
    : unresolvedMedia ? probing ? '解析完成后即可开始下载。'
      : probeError ? '请先重试解析，或打开来源网页。' : '解析成功后即可开始下载。'
    : '支持链接、磁力链与批量粘贴'

  const retryWithBrowser = (): void => {
    const target = url.trim()
    if (!target || probing || !sessionBrowser) return
    const browser = sessionBrowser
    const browserLabel = browserOptions.find(option => option.value === browser)?.label ?? browser
    retryCookieBrowser.current = browser
    const seq = ++probeSeq.current
    setAvailabilityNotice(undefined)
    setProbing(true)
    setProbeError(null)
    setProbeIssue(undefined)
    void probeMedia(target, browser).then((res) => {
      if (probeSeq.current !== seq) return
      setProbing(false)
      if (res && res.formats.length > 0) {
        setAvailabilityNotice(res.availabilityNotice)
        setMediaTitle(res.title || null)
        setMediaFormats(res.formats)
        setMediaSubtitles(res.subtitles)
        setMediaCollection(res.collection ?? null)
        setDuplicateCurrent(res.duplicateCurrent ?? null)
        setDuplicateCollection(res.duplicateCollection ?? null)
        setMediaCookieBrowser(browser)
        setMediaDuration(res.duration || 0)
        const preferred = preferredFormat(res.formats)
        setSelectedFormat(preferred.id)
        if (!filenameEdited.current) setFilename(res.title ? `${res.title}.${preferred.containerHint.toLowerCase()}` : '')
        const thumbnailURL = res.thumbnailURL || res.collection?.thumbnailURL
        if (thumbnailURL) {
          setMediaThumbnailURL(thumbnailURL)
          void window.ndm?.loadThumbnail(thumbnailURL).then((thumbnail) => {
            if (probeSeq.current === seq && thumbnail) setMediaThumbnail(thumbnail)
          }).catch(() => undefined)
        }
        cue('success')
      } else if (mediaAccessMessage(res?.errorKind)) {
        setProbeIssue(res?.errorKind)
        setProbeError(mediaAccessMessage(res?.errorKind))
      } else if (res?.errorKind === 'browserDataUnavailable') {
        setProbeIssue(res.errorKind)
        setProbeError(`无法读取 ${browserLabel} 的登录信息。请换一个浏览器重试。`)
      } else {
        setProbeIssue(res?.errorKind)
        setProbeError(`请在 ${browserLabel} 中确认可观看此视频，再重试。`)
      }
    }).catch(() => {
      if (probeSeq.current !== seq) return
      setProbing(false)
      setProbeIssue(undefined)
      setProbeError(`未能通过 ${browserLabel} 解析链接，请重试。`)
    })
  }

  const handleChooseFolder = async (): Promise<void> => {
    const session = destinationSession.current
    const choice = ++folderChoice.current
    const selected = await chooseFolder(folderPath)
    if (selected && destinationSession.current === session && folderChoice.current === choice) {
      folderEdited.current = true
      setFolderPath(selected)
    }
  }

  const baseOptions = (): { folderPath?: string; connections?: number } => ({
    folderPath: folderPath.trim() || undefined,
    connections: connections || undefined
  })

  const prepareBatch = (text: string): void => {
    draftEdited.current = true
    setBatchLinks((current) => appendBatchLinks(current, text, acceptedBatchURLs.current))
    setUrl('')
    setSharedSource(null)
    setErrorMsg(null)
    cue('tick')
  }

  // Paste prepares a reviewable draft. Only the confirmation button creates tasks.
  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    const resolutions = extractSharedLinks(text)
    if (resolutions.length === 0 || submitting) return
    event.preventDefault()
    draftEdited.current = true
    if (resolutions.length > 1 || batchMode) {
      prepareBatch(text)
      return
    }
    const resolution = resolutions[0]
    setUrl(resolution.urlString)
    setSharedSource(resolution.wasExtractedFromText ? resolution.source : null)
    setErrorMsg(null)
    cue('tick')
  }

  const submitBatch = (): void => {
    if (submitting || !batchLinks.length || url.trim()) return
    const session = destinationSession.current
    const options = baseOptions()
    const pending = batchLinks.slice()
    setSubmitting(true)
    setBatchCompleted(0)
    setBatchNotice(null)
    setBatchStopping(false)
    batchStopRequested.current = false
    setErrorMsg(null)
    void (async () => {
      const failed: ComposerBatchLink[] = []
      let lastTask: Task | null = null
      let succeeded = 0
      for (const [index, item] of pending.entries()) {
        if (destinationSession.current !== session) return
        try {
          lastTask = await addFromUrl({ url: item.url, ...options })
          if (destinationSession.current !== session) return
          acceptedBatchURLs.current.add(item.url)
          succeeded += 1
        } catch {
          failed.push({ ...item, failed: true })
        }
        if (destinationSession.current !== session) return
        setBatchCompleted(index + 1)
        if (batchStopRequested.current) {
          const remaining = [...failed, ...pending.slice(index + 1)]
          if (remaining.length) {
            setSubmitting(false)
            setBatchStopping(false)
            setBatchLinks(remaining)
            setBatchNotice(succeeded ? `已添加 ${succeeded} 项，其余 ${remaining.length} 项已保留。` : '尚未添加的链接已保留。')
            return
          }
        }
      }
      setSubmitting(false)
      if (failed.length) {
        setBatchLinks(failed)
        setBatchNotice(succeeded ? `已添加 ${succeeded} 项，${failed.length} 项未能添加。` : '未能添加这些下载，请重试。')
        return
      }
      if (lastTask) onCreated(lastTask.id, acceptedBatchURLs.current.size)
      onClose()
    })()
  }

  const submit = (): void => {
    if (batchMode) { submitBatch(); return }
    if (submitting) return
    const trimmed = resolveSharedLink(url)?.urlString
    if (!trimmed) { setErrorMsg('请输入有效的下载链接。'); return }
    if (COMMERCIALIZATION_DRAFT_ENABLED && collectionScope === 'all' && requiresPro('playlist')) {
      onUpgrade('整批下载播放列表与频道')
      return
    }
    // A media site's page URL has no ordinary-file form. Without a resolved
    // format the only thing the Neat engine could fetch here is the page's
    // own HTML — the exact bug that saved TikTok pages as "video.mp4".
    const accessFailure = mediaAccessMessage(probeIssue)
    if (accessFailure) { setErrorMsg(accessFailure); return }
    if (requiresResolvedMedia(trimmed, selectedFormat)) {
      setErrorMsg(`未能获取${siteName(trimmed)}视频，请先重试解析。`)
      return
    }
    setSubmitting(true)
    setErrorMsg(null)

    const session = destinationSession.current
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
        if (destinationSession.current !== session) return
        setSubmitting(false)
        setUrl('')
        onCreated(task.id, count)
        onClose()
      })
      .catch((error: unknown) => {
        if (destinationSession.current !== session) return
        setSubmitting(false)
        setErrorMsg(error instanceof Error ? error.message : '添加失败')
      })
  }

  const duplicate = collectionScope === 'all' ? duplicateCollection : duplicateCurrent

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!next && !submitting) onClose() }}>
      <Dialog.Portal container={document.getElementById('main-content')}>
      <Dialog.Backdrop className="absolute inset-0 z-10 bg-ink/18" />
      <Dialog.Viewport className="absolute inset-0 z-20 flex items-end justify-center px-6 pb-5">
        <Dialog.Popup render={<form />}
          initialFocus={urlInputRef}
          finalFocus={() => previousFocus.current?.isConnected && previousFocus.current !== document.body
            ? previousFocus.current : document.getElementById('ndm-search')}
          aria-describedby={undefined}
          className="ndm-composer flex max-h-[calc(100vh-44px)] w-full max-w-[980px] flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-popover"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="min-h-0 overflow-y-auto p-4 pb-0 scroll-quiet">
        <div className="flex items-center justify-between">
          <Dialog.Title className="text-[15px] font-medium text-paper">添加下载</Dialog.Title>
          <button
            type="button"
            onClick={() => setShowOptions(!showOptions)}
            aria-expanded={showOptions}
            className="flex items-center gap-1 text-[14px] text-mist transition-colors duration-150 hover:text-paper"
          >
            <Settings2 size={12} />
            <span>选项</span>
            {showOptions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
        <input
          ref={urlInputRef}
          aria-label="下载链接"
          disabled={submitting}
          value={url}
          onChange={(event) => {
            draftEdited.current = true
            setUrl(event.target.value)
            setSharedSource(null)
            setErrorMsg(null)
          }}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (batchMode && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (isDownloadableUrl(url)) prepareBatch(url)
            }
          }}
          placeholder={batchMode ? '继续粘贴链接，加入清单…' : '粘贴下载链接、磁力链或整段分享口令...'}
          aria-describedby={probeError ? 'composer-probe-status' : undefined}
          className="min-w-0 w-full bg-transparent font-sans text-[17px] tracking-[-0.01em] text-paper outline-none placeholder:text-mist/70"
          spellCheck={false}
        />
        {batchMode && url.trim() ? <button type="button" disabled={submitting || !isDownloadableUrl(url)} onClick={() => prepareBatch(url)} className="shrink-0 rounded-control border border-line-strong px-3 py-1.5 text-fog hover:bg-line disabled:opacity-40">加入清单</button> : null}
        </div>

        {batchMode ? <ComposerBatchReview links={batchLinks} busy={submitting} completed={batchCompleted} onRemove={(target) => { setBatchLinks((items) => items.filter(item => item.url !== target)); setBatchNotice(null) }} /> : null}
        {batchNotice ? <p role="status" data-batch-notice className={`mt-3 text-[13px] leading-relaxed ${batchLinks.some(item => item.failed) ? 'text-clay' : 'text-fog'}`}>{batchNotice}</p> : null}

        {sharedSource ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-copper">
            <Link2 size={11} strokeWidth={1.7} />
            已从{sharedLinkSourceLabel(sharedSource)}分享口令中提取链接
          </div>
        ) : null}

        {duplicate ? (
          <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-sage/9 px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ok)_22%,transparent)]">
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
              className="shrink-0 rounded-control px-2.5 py-1 text-[10.5px] font-medium text-sage shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ok)_28%,transparent)] transition-[background-color,scale] duration-100 hover:bg-sage/10 active:scale-[0.96]"
            >
              查看已有
            </button>
          </div>
        ) : null}

        {probing || mediaFormats.length > 0 || probeError ? (
          <div className="composer-media-card animate-fade-up mt-3 overflow-hidden rounded-xl border border-line-strong bg-panel/78">
            <div className="composer-media-summary flex gap-3 p-3">
              <div className="composer-media-artwork relative grid h-[94px] w-[168px] shrink-0 place-items-center overflow-hidden rounded-xl bg-ink/55 shadow-[inset_0_0_0_1px_var(--line)]">
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
                <h3 className="mt-2 line-clamp-2 font-sans font-medium text-[18px] leading-snug text-paper">
                  {mediaTitle || (probing ? '正在读取视频信息…' : '网页视频')}
                </h3>
                {availabilityNotice === 'previewOnly' && mediaFormats.length > 0 ? (
                  <p data-media-availability="previewOnly" role="status" className="mt-1.5 text-[11.5px] text-mist">当前仅提供预览</p>
                ) : null}
                {probing ? <div className="mt-2"><LoadingMark label="正在解析清晰度与音视频轨…" /></div> : null}
                {probeError || (probing && retryCookieBrowser.current) ? (
                  <div className="mt-2">
                    <p id="composer-probe-status" role="status" aria-live="polite" className="text-[11.5px] leading-relaxed text-clay">{probeError}</p>
                    <div className="composer-media-actions mt-2 flex flex-wrap items-center gap-1.5">
                      {probeIssue !== 'regionRestricted' && (probeIssue === 'browserSessionRequired' || probeIssue === 'browserDataUnavailable' || probeIssue === 'entitlementRequired' || retryCookieBrowser.current) ? (
                        <select aria-label="会话浏览器" value={sessionBrowser ?? ''} disabled={probing}
                          onChange={event => setSessionBrowser(initialMediaSessionBrowser(event.target.value, IS_WINDOWS))}
                          className="h-7 rounded-[8px] border border-line bg-panel px-2 text-[10.5px] text-fog disabled:opacity-50">
                          <option value="" disabled>选择浏览器</option>
                          {browserOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : null}
                      {(probeIssue === 'browserSessionRequired' || probeIssue === 'browserDataUnavailable' || probeIssue === 'entitlementRequired' || (probing && retryCookieBrowser.current)) ? (
                        <button
                          type="button"
                          onClick={retryWithBrowser}
                          disabled={probing || !sessionBrowser}
                          className="h-7 rounded-[8px] bg-copper px-2.5 text-[10.5px] font-medium text-on-accent transition-[filter,scale] duration-100 active:scale-[0.96]"
                        >
                          使用 {sessionBrowserLabel} 会话重试
                        </button>
                      ) : !probing ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (probeIssue !== 'regionRestricted' && retryCookieBrowser.current !== null) retryWithBrowser()
                            else setProbeNonce((value) => value + 1)
                          }}
                          className="h-7 rounded-[8px] bg-copper px-2.5 text-[10.5px] font-medium text-on-accent transition-[filter,scale] duration-100 active:scale-[0.96]"
                        >
                          重试解析
                        </button>
                      ) : null}
                      {(probeIssue === 'entitlementRequired' || probeIssue === 'browserDataUnavailable') && !probing ? (
                        <button type="button" onClick={() => {
                          if (retryCookieBrowser.current !== null && sessionBrowser) retryWithBrowser()
                          else setProbeNonce((value) => value + 1)
                        }} className="h-7 rounded-[8px] px-2.5 text-[10.5px] text-fog shadow-[inset_0_0_0_1px_var(--line)]">
                          重试解析
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
                  <div className="mb-3 rounded-xl bg-ink/25 p-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
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
                        <SegmentedControl
                          fit="hug"
                          value={collectionScope}
                          onChange={(scope) => {
                            if (scope === 'all' && COMMERCIALIZATION_DRAFT_ENABLED && requiresPro('playlist')) {
                              onUpgrade('整批下载播放列表与频道')
                              return
                            }
                            setCollectionScope(scope)
                          }}
                          options={[
                            { value: 'current', label: '当前视频' },
                            {
                              value: 'all',
                              label: mediaCollection.isTruncated
                                ? `前 ${mediaCollection.availableItemCount} 项`
                                : `整个合集 · ${mediaCollection.itemCount}`
                            }
                          ]}
                        />
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
                    const high = isHighBitrate(fmt)
                    return (
                      <button
                        key={fmt.id}
                        type="button"
                        data-cuelume-press="tick"
                        onClick={() => {
                          if (locked) {
                            onUpgrade('4K / 8K 超清下载')
                            return
                          }
                          setSelectedFormat(fmt.id)
                          if (mediaTitle && !filenameEdited.current) setFilename(`${mediaTitle}.${container === 'compatibleMP4' ? 'mp4' : 'mkv'}`)
                        }}
                        className={`flex min-w-0 items-center justify-between rounded-[9px] border px-2.5 py-2 text-left transition-[color,background-color,border-color,scale] duration-100 active:scale-[0.96] ${
                          selectedFormat === fmt.id
                            ? 'border-copper/65 bg-copper/14 text-paper'
                            : locked
                              ? 'border-line bg-ink/12 text-mist hover:border-copper/40'
                              : high
                                ? 'border-copper/35 bg-copper/8 text-fog hover:border-copper/55 hover:bg-copper/12'
                                : 'border-line bg-ink/20 text-fog hover:border-line-strong hover:bg-raised/70'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-1">
                            {high ? <Sparkles size={11} strokeWidth={2.2} className="shrink-0 text-copper" aria-hidden /> : null}
                            <span className="block truncate text-[11.5px] font-medium">{fmt.label}</span>
                          </span>
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
                    <SegmentedControl
                      value={container}
                      onChange={(value) => {
                        setContainer(value)
                        if (mediaTitle && !filenameEdited.current) {
                          setFilename((current) => current === `${mediaTitle}.mp4` || current === `${mediaTitle}.mkv`
                            ? `${mediaTitle}.${value === 'compatibleMP4' ? 'mp4' : 'mkv'}`
                            : current)
                        }
                      }}
                      options={[
                        { value: 'compatibleMP4', label: 'MP4' },
                        { value: 'compactMKV', label: 'MKV' }
                      ]}
                    />
                  </div>
                  <label>
                    <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.1em] text-mist">字幕</span>
                    <span className="relative block">
                      <select
                        value={selectedSubtitle ?? ''}
                        onChange={(event) => {
                          setSelectedSubtitle(event.target.value || null)
                          cue('tick')
                        }}
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

        <div data-composer-destination className="mt-3 flex items-center justify-between gap-3 text-[12.5px]">
          <span className="shrink-0 text-mist">保存目录</span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-panel/60 px-2.5 py-1">
            <Folder size={13} className="shrink-0 text-mist" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fog" title={folderPath}>
              {folderPath || '默认下载目录'}
            </span>
            <button
              type="button"
              onClick={handleChooseFolder}
              className="shrink-0 rounded px-1.5 py-0.5 text-[14px] text-copper transition-colors hover:bg-line"
            >
              浏览
            </button>
          </div>
        </div>

        {showOptions ? (
          <div className="animate-fade-up mt-3 space-y-2.5 border-t border-line/60 pt-3 text-[12.5px]">
            {!batchMode ? <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-mist">重命名</span>
              <input
                value={filename}
                aria-label="重命名"
                onChange={(e) => { filenameEdited.current = Boolean(e.target.value); setFilename(e.target.value) }}
                placeholder="留空自动识别文件名"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel/60 px-2.5 py-1 text-[13px] text-fog outline-none placeholder:text-mist/60"
              />
            </div> : null}

            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-mist">分段连接</span>
              <SquareChoice
                value={connections}
                options={CONNECTION_OPTIONS}
                onChange={(value) => { connectionsEdited.current = true; setConnections(value) }}
                aria-label="分段连接"
              />
            </div>
          </div>
        ) : null}

        {errorMsg ? (
          <div role="status" className="mt-2 text-[13px] text-clay">{errorMsg}</div>
        ) : null}
        </div>

        <div className="mx-4 mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line/50 py-3 text-[12px] text-mist">
          <span id="composer-submit-hint">{batchMode ? '确认清单和保存位置后开始下载' : submissionHint}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (submitting && batchMode) { batchStopRequested.current = true; setBatchStopping(true) }
                else onClose()
              }}
              disabled={submitting && (!batchMode || batchStopping)}
              className="h-8 rounded-control px-3 text-[14px] text-mist transition-colors hover:bg-line hover:text-paper disabled:opacity-50"
            >
              {submitting && batchMode ? batchStopping ? '正在停止…' : '停止添加' : '取消'}
            </button>
            <button
              type="submit"
              data-cuelume-press
              data-cuelume-release
              aria-busy={submitting}
              aria-describedby={mediaSubmitBlocked ? 'composer-submit-hint' : undefined}
              className="ndm-primary-action ndm-control inline-flex h-8 items-center justify-center gap-2 rounded-control bg-copper px-4 text-[14px] font-medium text-on-accent disabled:opacity-45"
              disabled={(batchMode ? Boolean(url.trim()) : !url.trim()) || submitting || mediaSubmitBlocked || storageConfidence?.level === 'insufficient'}
            >
              <span className="grid size-3.5 place-items-center" aria-hidden>{submitting ? <LoaderCircle size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}</span>
              {submitting
                ? '正在添加...'
                : batchMode
                  ? `${batchLinks.some(item => item.failed) ? '重试' : '下载'} ${batchLinks.length} 项`
                : duplicate
                  ? '仍要再下一份'
                  : collectionScope === 'all' && mediaCollection
                    ? `下载${mediaCollection.isTruncated ? `前 ${mediaCollection.availableItemCount} 项` : `整个合集 · ${mediaCollection.itemCount}`}`
                    : '开始下载'}
            </button>
          </div>
        </div>
      </Dialog.Popup>
      </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
