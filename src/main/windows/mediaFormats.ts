export type YtDlpRawFormat = {
  format_id?: string | number
  format_note?: string
  ext?: string
  height?: number
  filesize?: number
  filesize_approx?: number
  tbr?: number
  abr?: number
  vcodec?: string
  acodec?: string
  url?: string
}

export type MediaFormatTier = {
  id: string
  label: string
  height: number
  approximateBytes: number
  componentBytes: number[]
  compactApproximateBytes: number
  compactComponentBytes: number[]
  containerHint: string
  isVideo: boolean
  isHighBitrate: boolean
  compatibleSelector: string
  compactSelector: string
}

export type MediaProgressReport = {
  componentID: string
  downloadedBytes: number
  totalBytes: number
  bytesPerSecond: number
  status: string
}

const HIGH_BITRATE_IDS = new Set(['616', '356'])
const LADDER = [2160, 1440, 1080, 720, 480, 360, 240]

export function isYouTubeMediaURL(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\.+|\.+$/g, '')
    return ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com']
      .some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

export function canonicalYouTubeFormatID(raw: string): string {
  return raw.split('-')[0] ?? raw
}

export function isYouTubeHighBitrateFormat(format: YtDlpRawFormat): boolean {
  const id = canonicalYouTubeFormatID(String(format.format_id ?? ''))
  if (HIGH_BITRATE_IDS.has(id)) return true
  const note = String(format.format_note ?? '').toLowerCase()
  return note.includes('premium') || note.includes('enhanced bitrate')
}

function qualityHeight(format: YtDlpRawFormat): number {
  const match = String(format.format_note ?? '').match(/\b(\d{3,4})p/)
  return match ? Number(match[1]) : Math.max(0, Number(format.height ?? 0))
}

function isVideo(format: YtDlpRawFormat): boolean {
  return Boolean(format.vcodec && format.vcodec !== 'none')
}

function isAudioOnly(format: YtDlpRawFormat): boolean {
  return (format.vcodec ?? 'none') === 'none' && Boolean(format.acodec && format.acodec !== 'none')
}

function hasAudio(format: YtDlpRawFormat | undefined): boolean {
  return Boolean(format?.acodec && format.acodec !== 'none')
}

const DIRECT_MEDIA_EXTENSIONS = new Set([
  'mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi', 'flv', 'ts', 'm3u8',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'
])

/** GenericExtractor also returns ordinary attachments as one fake format. */
export function isPlayableMediaInfo(info: YtDlpRawFormat): boolean {
  if (isVideo(info) || hasAudio(info)) return true
  return DIRECT_MEDIA_EXTENSIONS.has(String(info.ext ?? '').toLowerCase())
}

function reportedBytes(format: YtDlpRawFormat | undefined): number {
  if (!format) return 0
  return Math.max(0, Number(format.filesize ?? format.filesize_approx ?? 0))
}

function estimateBytes(format: YtDlpRawFormat | undefined, duration: number, audio = false): number {
  const exact = reportedBytes(format)
  if (exact > 0) return exact
  if (!format || duration <= 0) return 0
  const kbps = audio ? Number(format.abr ?? format.tbr ?? 0) : Number(format.tbr ?? 0)
  return kbps > 0 ? Math.round((kbps * 1000 / 8) * duration) : 0
}

function bestVideo(
  formats: YtDlpRawFormat[],
  predicate: (format: YtDlpRawFormat) => boolean = () => true
): YtDlpRawFormat | undefined {
  const candidates = formats.filter((format) => isVideo(format) && predicate(format))
  const videoOnly = candidates.filter((format) => !hasAudio(format))
  const pool = videoOnly.length > 0 ? videoOnly : candidates
  return pool.slice().sort((left, right) => {
    const heightDelta = qualityHeight(right) - qualityHeight(left)
    if (heightDelta !== 0) return heightDelta
    return Number(right.tbr ?? 0) - Number(left.tbr ?? 0)
  })[0]
}

function bestAudio(formats: YtDlpRawFormat[], preferAAC = false): YtDlpRawFormat | undefined {
  const pool = formats.filter(isAudioOnly)
  const narrowed = preferAAC
    ? pool.filter((format) => String(format.acodec ?? '').startsWith('mp4a'))
    : pool
  return (narrowed.length > 0 ? narrowed : pool).slice().sort((left, right) => (
    Number(right.tbr ?? right.abr ?? 0) - Number(left.tbr ?? left.abr ?? 0)
  ))[0]
}

function exactSelector(video: YtDlpRawFormat | undefined, audio: YtDlpRawFormat | undefined): string | undefined {
  const videoID = String(video?.format_id ?? '')
  if (!videoID) return undefined
  if (hasAudio(video)) return videoID
  const audioID = String(audio?.format_id ?? '')
  return audioID ? `${videoID}+${audioID}` : undefined
}

function componentEstimate(
  video: YtDlpRawFormat | undefined,
  audio: YtDlpRawFormat | undefined,
  duration: number
): number[] {
  const videoBytes = estimateBytes(video, duration)
  const audioBytes = hasAudio(video) ? 0 : estimateBytes(audio, duration, true)
  return [videoBytes, audioBytes].filter((value) => value > 0)
}

function fallbackSelector(height: number, compact: boolean): string {
  const limit = height > 0 ? `[height<=${height}]` : ''
  return compact
    ? `bestvideo${limit}[vcodec^=av01]+bestaudio/bestvideo${limit}[vcodec^=vp9]+bestaudio/best${limit}`
    : `bestvideo${limit}[ext=mp4]+bestaudio[acodec^=mp4a]/bestvideo${limit}+bestaudio/best${limit}[ext=mp4]/best${limit}`
}

function mergedTier(
  formats: YtDlpRawFormat[],
  height: number,
  duration: number,
  highBitrate: boolean,
  separateYouTubeHighBitrate: boolean
): MediaFormatTier | null {
  const atHeight = formats.filter((format) => qualityHeight(format) === height)
  const candidates = highBitrate
    ? atHeight.filter(isYouTubeHighBitrateFormat)
    : separateYouTubeHighBitrate
      ? atHeight.filter((format) => !isYouTubeHighBitrateFormat(format))
      : atHeight
  if (candidates.length === 0) return null

  const compatibleVideo = highBitrate
    ? bestVideo(candidates)
    : bestVideo(candidates, (format) => String(format.vcodec ?? '').startsWith('avc1'))
      ?? bestVideo(candidates, (format) => format.ext === 'mp4')
      ?? bestVideo(candidates)
  const compactVideo = highBitrate
    ? compatibleVideo
    : bestVideo(candidates, (format) => /^(av01|vp0?9)/.test(String(format.vcodec ?? '')))
      ?? bestVideo(candidates)
  if (!compatibleVideo || !compactVideo) return null

  const compatibleAudio = hasAudio(compatibleVideo) ? undefined : (bestAudio(formats, true) ?? bestAudio(formats))
  const compactAudio = hasAudio(compactVideo) ? undefined : bestAudio(formats)
  const compatibleSelector = exactSelector(compatibleVideo, compatibleAudio) ?? fallbackSelector(height, false)
  const compactSelector = exactSelector(compactVideo, compactAudio) ?? fallbackSelector(height, true)
  const compatibleComponents = componentEstimate(compatibleVideo, compatibleAudio, duration)
  const compactComponents = componentEstimate(compactVideo, compactAudio, duration)
  return {
    id: compatibleSelector,
    label: highBitrate ? `${height}p 高码率` : `${height}p`,
    height,
    approximateBytes: compatibleComponents.reduce((sum, value) => sum + value, 0),
    componentBytes: compatibleComponents,
    compactApproximateBytes: compactComponents.reduce((sum, value) => sum + value, 0),
    compactComponentBytes: compactComponents,
    containerHint: 'MP4',
    isVideo: true,
    isHighBitrate: highBitrate,
    compatibleSelector,
    compactSelector
  }
}

function progressiveTiers(formats: YtDlpRawFormat[]): MediaFormatTier[] {
  const candidates = formats
    .filter((format) => format.url && isVideo(format) && hasAudio(format))
    .sort((left, right) => qualityHeight(right) - qualityHeight(left) || Number(right.tbr ?? 0) - Number(left.tbr ?? 0))
  const byHeight = new Map<number, YtDlpRawFormat>()
  for (const candidate of candidates) {
    const height = qualityHeight(candidate)
    if (!byHeight.has(height)) byHeight.set(height, candidate)
  }
  return Array.from(byHeight.values()).slice(0, 8).map((format) => {
    const height = qualityHeight(format)
    const bytes = reportedBytes(format)
    const selector = String(format.format_id ?? 'best')
    return {
      id: selector,
      label: height > 0 ? `${height}p` : String(format.format_note ?? '最佳兼容画质'),
      height,
      approximateBytes: bytes,
      componentBytes: bytes ? [bytes] : [],
      compactApproximateBytes: bytes,
      compactComponentBytes: bytes ? [bytes] : [],
      containerHint: String(format.ext ?? 'mp4').toUpperCase(),
      isVideo: true,
      isHighBitrate: false,
      compatibleSelector: selector,
      compactSelector: selector
    }
  })
}

export function buildMediaFormatTiers(
  formats: YtDlpRawFormat[],
  duration = 0,
  options: { allowMerging?: boolean; includeYouTubeHighBitrate?: boolean } = {}
): MediaFormatTier[] {
  if (!options.allowMerging) return progressiveTiers(formats)
  const heights = new Set(formats.filter(isVideo).map(qualityHeight).filter((height) => height > 0))
  let picked = LADDER.filter((height) => heights.has(height))
  if (picked.length === 0) picked = Array.from(heights).sort((a, b) => b - a).slice(0, 4)
  const tiers: MediaFormatTier[] = []
  for (const height of picked) {
    if (options.includeYouTubeHighBitrate) {
      const high = mergedTier(formats, height, duration, true, true)
      if (high) tiers.push(high)
    }
    const regular = mergedTier(formats, height, duration, false, options.includeYouTubeHighBitrate === true)
    if (regular) tiers.push(regular)
  }
  return tiers
}

export function requiresMediaMerge(selector: string): boolean {
  return selector.includes('+')
}

export function mediaDownloadArguments(options: {
  pageURL: string
  selector: string
  outputPath: string
  container: 'compatibleMP4' | 'compactMKV'
  ffmpegPath: string
  connections: number
  subtitleLanguage?: string
  cookieBrowser?: string
  proxy?: string
  bandwidthLimit?: number
  temporaryDirectory?: string
  forceOverwrite?: boolean
}): string[] {
  const args = [
    '-f', options.selector,
    '--merge-output-format', options.container === 'compactMKV' ? 'mkv' : 'mp4',
    '-o', options.outputPath,
    '--no-playlist',
    '--newline',
    '--progress',
    '--progress-template', 'download:NDM_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s|%(progress.status)s',
    '--print', 'after_move:NDM_DEST|%(filepath)s',
    '--no-simulate',
    '--socket-timeout', '20',
    options.forceOverwrite ? '--no-continue' : '--continue',
    '--ffmpeg-location', options.ffmpegPath,
    '--concurrent-fragments', String(Math.max(1, Math.min(16, options.connections)))
  ]
  if (options.temporaryDirectory) {
    args.push('--paths', `temp:${options.temporaryDirectory}`)
  }
  if (options.forceOverwrite) args.push('--force-overwrites')
  if (options.subtitleLanguage) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', options.subtitleLanguage, '--sub-format', 'srt/best', '--convert-subs', 'srt')
  }
  if (options.cookieBrowser) args.push('--cookies-from-browser', options.cookieBrowser)
  if (options.proxy) args.push('--proxy', options.proxy)
  if (options.bandwidthLimit && options.bandwidthLimit > 0) args.push('--limit-rate', String(options.bandwidthLimit))
  args.push('--', options.pageURL)
  return args
}

function numeric(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function parseYtDlpProgressLine(line: string): MediaProgressReport | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('NDM_PROGRESS|')) return null
  const parts = trimmed.split('|')
  if (parts.length < 7) return null
  const total = numeric(parts[2]) || numeric(parts[3])
  return {
    downloadedBytes: numeric(parts[1]),
    totalBytes: total,
    bytesPerSecond: numeric(parts[4]),
    componentID: parts[5] && parts[5] !== 'NA' ? parts[5] : 'media',
    status: parts[6] ?? ''
  }
}

export function parseYtDlpDestinationLine(line: string): string | null {
  const trimmed = line.trim()
  return trimmed.startsWith('NDM_DEST|') ? trimmed.slice('NDM_DEST|'.length).trim() || null : null
}
