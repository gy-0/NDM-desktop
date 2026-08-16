export type SharedLinkSource =
  | 'youtube'
  | 'bilibili'
  | 'douyin'
  | 'xiaohongshu'
  | 'tiktok'
  | 'kuaishou'
  | 'weibo'
  | 'instagram'
  | 'x'
  | 'facebook'
  | 'vimeo'
  | 'twitch'
  | 'dailymotion'
  | 'magnet'
  | 'web'

export type SharedLinkResolution = {
  urlString: string
  source: SharedLinkSource
  wasExtractedFromText: boolean
}

const URL_EXPRESSION = /(?:(?:https?|ftp):\/\/|magnet:\?)[^\s<>"'，。；：！？）》】」』、]+/gi
const KNOWN_HOST_EXPRESSION = /(?<![\w.])(?:(?:www\.|m\.|music\.)?youtube\.com|youtu\.be|(?:www\.|m\.)?bilibili\.com|b23\.tv|(?:www\.|v\.)?douyin\.com|[\w.-]+\.iesdouyin\.com|(?:www\.)?xiaohongshu\.com|(?:[\w-]+\.)?xhslink\.com|(?:www\.|vm\.|vt\.)?tiktok\.com|(?:www\.|v\.|m\.)?kuaishou\.com|(?:www\.|m\.)?weibo\.(?:com|cn)|(?:www\.)?instagram\.com|(?:www\.)?(?:x|twitter)\.com|fb\.watch|(?:www\.|m\.)?facebook\.com|(?:www\.)?vimeo\.com|(?:www\.)?twitch\.tv|dai\.ly|(?:www\.)?dailymotion\.com)\/[^\s<>"'，。；：！？）》】」』、]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?\])}>，。；：！？）》】」』、…]+$/u
const SHORT_HOSTS = new Set([
  'b23.tv',
  'youtu.be',
  'v.douyin.com',
  'xhslink.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'v.kuaishou.com',
  'fb.watch',
  'dai.ly'
])

const SOURCE_LABELS: Record<SharedLinkSource, string> = {
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  douyin: '抖音',
  xiaohongshu: '小红书',
  tiktok: 'TikTok',
  kuaishou: '快手',
  weibo: '微博',
  instagram: 'Instagram',
  x: 'X',
  facebook: 'Facebook',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  dailymotion: 'Dailymotion',
  magnet: 'BT 磁力链',
  web: '网页'
}

export function sharedLinkSourceLabel(source: SharedLinkSource): string {
  return SOURCE_LABELS[source]
}

function prepareInput(value: string): string {
  const widthMap: Record<string, string> = {
    '＃': '#', '％': '%', '＆': '&', '＋': '+', '－': '-', '．': '.', '／': '/',
    '：': ':', '＝': '=', '？': '?', '＠': '@', '＿': '_', '～': '~'
  }
  return value
    .replace(/&amp;/g, '&')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/[０-９Ａ-Ｚａ-ｚ＃％＆＋－．／：＝？＠＿～]/g, (character) => {
      if (widthMap[character]) return widthMap[character]
      return String.fromCharCode(character.charCodeAt(0) - 0xfee0)
    })
}

function sourceForHost(host: string): SharedLinkSource {
  const matches = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  if (host === 'youtu.be' || matches('youtube.com')) return 'youtube'
  if (host === 'b23.tv' || matches('bilibili.com')) return 'bilibili'
  if (matches('douyin.com') || matches('iesdouyin.com')) return 'douyin'
  if (matches('xhslink.com') || matches('xiaohongshu.com')) return 'xiaohongshu'
  if (matches('tiktok.com')) return 'tiktok'
  if (matches('kuaishou.com')) return 'kuaishou'
  if (matches('weibo.com') || matches('weibo.cn')) return 'weibo'
  if (matches('instagram.com')) return 'instagram'
  if (matches('x.com') || matches('twitter.com')) return 'x'
  if (host === 'fb.watch' || matches('facebook.com')) return 'facebook'
  if (matches('vimeo.com')) return 'vimeo'
  if (matches('twitch.tv')) return 'twitch'
  if (host === 'dai.ly' || matches('dailymotion.com')) return 'dailymotion'
  return 'web'
}

function clean(raw: string, prependScheme = false): string {
  const value = raw.replace(TRAILING_PUNCTUATION, '')
  return prependScheme && !value.includes('://') ? `https://${value}` : value
}

export function extractSharedLinks(raw: string): SharedLinkResolution[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 32_768) return []
  const prepared = prepareInput(trimmed)
  const candidates = [
    ...Array.from(prepared.matchAll(URL_EXPRESSION), (match) => ({ value: clean(match[0]), index: match.index ?? 0 })),
    ...Array.from(prepared.matchAll(KNOWN_HOST_EXPRESSION), (match) => ({
      value: clean(match[0], true),
      index: match.index ?? 0
    }))
  ]
  const seen = new Set<string>()
  return candidates
    .flatMap((candidate) => {
      if (seen.has(candidate.value)) return []
      try {
        const url = new URL(candidate.value)
        if (!['http:', 'https:', 'ftp:', 'magnet:'].includes(url.protocol)) return []
        seen.add(candidate.value)
        const source = url.protocol === 'magnet:' ? 'magnet' : sourceForHost(url.hostname.toLowerCase())
        const mediaPath = /\/(video|watch|shorts|reels?|tv|play|live|photo|explore)\//i.test(url.pathname)
        const score = (source === 'web' ? 0 : 100) + (SHORT_HOSTS.has(url.hostname) ? 30 : 0) + (mediaPath ? 18 : 0)
        return [{ ...candidate, source, score }]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => ({
      urlString: candidate.value,
      source: candidate.source,
      wasExtractedFromText: prepared.trim() !== candidate.value
    }))
}

export function resolveSharedLink(raw: string): SharedLinkResolution | null {
  return extractSharedLinks(raw)[0] ?? null
}
