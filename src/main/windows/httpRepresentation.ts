import { createHash } from 'node:crypto'

export const HTTP_DOWNLOAD_USER_AGENT = 'NDM'

/** Metadata belongs to one effective URL. Do not persist signed URLs or headers. */
export type HTTPRepresentation = { version: 1; resourceHash: string; etag: string; totalBytes: number }
export type HTTPProbeReply = { status: number; url: string; headers: Record<string, string | string[] | undefined> }
export type HTTPProbeRequest = { url: string; headers: Record<string, string>; signal?: AbortSignal }
export type HTTPProbeTransport = (request: HTTPProbeRequest) => Promise<HTTPProbeReply>

export class HTTPRepresentationError extends Error {
  constructor(message = '无法确认下载来源仍是同一份文件，不能安全续传。请重新下载。') { super(message) }
}

const hashURL = (url: string): string => createHash('sha256').update(url).digest('hex')
const field = (headers: HTTPProbeReply['headers'], name: string): string | undefined => {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name)
  if (entries.length !== 1) return undefined
  const value = entries[0][1]
  return typeof value === 'string' ? value.trim() : Array.isArray(value) && value.length === 1 ? value[0].trim() : undefined
}
const strongETag = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 4096 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)

export function readHTTPRepresentation(value: unknown): HTTPRepresentation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Partial<HTTPRepresentation>
  if (v.version !== 1 || !/^[a-f0-9]{64}$/.test(v.resourceHash ?? '') || !strongETag(v.etag)
    || !Number.isSafeInteger(v.totalBytes) || v.totalBytes! < 0) return undefined
  return { version: 1, resourceHash: v.resourceHash!, etag: v.etag, totalBytes: v.totalBytes! }
}

/** A weak/missing validator permits a clean single stream, never byte joining. */
export function representationFromProbe(reply: HTTPProbeReply): HTTPRepresentation | undefined {
  const encoding = field(reply.headers, 'content-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') throw new HTTPRepresentationError('服务器返回了不支持的内容编码。')
  const etag = field(reply.headers, 'etag')
  if (!strongETag(etag)) return undefined
  if (!/^https?:$/.test(new URL(reply.url).protocol)) throw new HTTPRepresentationError('下载来源协议无效。')
  let totalBytes: number
  if (reply.status === 206) {
    const range = field(reply.headers, 'content-range')?.match(/^bytes 0-0\/(\d+)$/i)
    if (!range) throw new HTTPRepresentationError('服务器返回了错误的下载范围。')
    totalBytes = Number(range[1])
    if (totalBytes < 1) throw new HTTPRepresentationError('服务器返回了错误的文件大小。')
  } else if (reply.status === 200) {
    const length = field(reply.headers, 'content-length')
    if (!length || !/^\d+$/.test(length)) return undefined
    totalBytes = Number(length)
  } else return undefined
  if (!Number.isSafeInteger(totalBytes)) throw new HTTPRepresentationError('服务器返回了无效的文件大小。')
  return { version: 1, resourceHash: hashURL(reply.url), etag, totalBytes }
}

export function assertSameHTTPRepresentation(saved: unknown, current: HTTPRepresentation | undefined): HTTPRepresentation {
  const previous = readHTTPRepresentation(saved)
  if (!previous || !current || previous.resourceHash !== current.resourceHash
    || previous.etag !== current.etag || previous.totalBytes !== current.totalBytes) throw new HTTPRepresentationError()
  return previous
}

/** Apply both guards: If-Range prevents unsafe byte joining; If-Match also guards full responses. */
export function representationHeaders(identity: HTTPRepresentation): Record<string, string> {
  const valid = readHTTPRepresentation(identity)
  if (!valid) throw new HTTPRepresentationError()
  return { 'If-Range': valid.etag, 'If-Match': valid.etag, 'Accept-Encoding': 'identity' }
}

export async function probeHTTPRepresentation(
  url: string, inputHeaders: string[], once: HTTPProbeTransport, signal?: AbortSignal
): Promise<HTTPRepresentation | undefined> {
  let current = new URL(url)
  if (!/^https?:$/.test(current.protocol) || current.username || current.password) throw new HTTPRepresentationError('下载来源 URL 无效。')
  let headers: Record<string, string> = { 'user-agent': HTTP_DOWNLOAD_USER_AGENT }
  for (const line of inputHeaders) {
    const colon = line.indexOf(':')
    if (colon < 1 || /[\r\n]/.test(line)) throw new HTTPRepresentationError('下载请求头无效。')
    const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new HTTPRepresentationError('下载请求头无效。')
    if (!['range', 'if-range', 'if-match', 'accept-encoding', 'host', 'content-length'].includes(name)) headers[name] = value
  }
  for (let hop = 0; hop < 6; hop++) {
    signal?.throwIfAborted()
    const reply = await once({ url: current.href, headers: { ...headers, range: 'bytes=0-0', 'accept-encoding': 'identity' }, signal })
    // Transport must return this hop without automatically following redirects.
    if (new URL(reply.url).href !== current.href) throw new HTTPRepresentationError('下载来源发生了未验证的重定向。')
    if (![301, 302, 303, 307, 308].includes(reply.status)) return representationFromProbe(reply)
    const location = field(reply.headers, 'location')
    if (!location) throw new HTTPRepresentationError('下载重定向缺少目标地址。')
    const next = new URL(location, current)
    if (!/^https?:$/.test(next.protocol) || next.username || next.password || (current.protocol === 'https:' && next.protocol !== 'https:')) {
      throw new HTTPRepresentationError('下载重定向不安全。')
    }
    // Custom headers can be credentials too; retain only explicitly harmless ones.
    if (next.origin !== current.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => ['user-agent', 'accept', 'accept-language'].includes(name)))
    current = next
  }
  throw new HTTPRepresentationError('下载重定向次数过多。')
}
