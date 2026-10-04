import { createHash } from 'node:crypto'

export type PostSubmission = { version: 1; body: string; contentType?: string; requiredHeaders: string[]; attempted: boolean }
export function normalizePostSubmission(extra: Record<string, unknown>): PostSubmission | undefined {
  const method = String(extra.method ?? 'GET').trim().toUpperCase()
  const supplied = [extra.body, extra.postData].filter(value => value !== undefined && value !== null)
  if (method === 'GET' && supplied.every(value => value === '')) return undefined
  if (method !== 'POST') throw new Error('非 GET 下载目前只支持明确的 POST 请求。')
  if (supplied.length > 1 || supplied.some(value => typeof value !== 'string')) throw new Error('POST 正文格式无效')
  const raw = typeof extra.postData === 'string' ? extra.postData : undefined
  if (raw !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new Error('POST 正文编码无效')
  const body = raw === undefined ? Buffer.from(typeof extra.body === 'string' ? extra.body : '', 'utf8') : Buffer.from(raw, 'base64')
  if (body.byteLength > 16 * 1024 * 1024) throw new Error('POST 正文过大')
  const types = (Array.isArray(extra.headers) ? extra.headers.map(String) : []).filter(line => /^content-type\s*:/i.test(line))
  if (types.length > 1 || types.some(line => /[\r\n]/.test(line))) throw new Error('POST 内容类型无效')
  const requiredHeaders = [...new Set((Array.isArray(extra.headers) ? extra.headers.map(String) : []).map(line => line.slice(0, line.indexOf(':')).trim().toLowerCase()).filter(name => name !== 'content-type'))]
  if (requiredHeaders.some(name => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))) throw new Error('POST 请求头无效')
  return { version: 1, requiredHeaders, body: body.toString('base64'), ...(types.length ? { contentType: types[0].slice(types[0].indexOf(':') + 1).trim() } : {}), attempted: false }
}
export function readPostSubmission(value: unknown): PostSubmission | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('POST 下载记录无效')
  const input = value as PostSubmission
  if (input.version !== 1 || typeof input.body !== 'string' || typeof input.attempted !== 'boolean'
    || input.contentType !== undefined && (typeof input.contentType !== 'string' || /[\r\n]/.test(input.contentType))) throw new Error('POST 下载记录无效')
  if (!Array.isArray(input.requiredHeaders) || input.requiredHeaders.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))) throw new Error('POST 请求头记录无效')
  return { ...normalizePostSubmission({ method: 'POST', postData: input.body, headers: input.contentType ? [`Content-Type: ${input.contentType}`] : [] })!, requiredHeaders: input.requiredHeaders, attempted: input.attempted }
}
export function postIntent(submission: PostSubmission): Record<string, unknown> {
  return { method: 'POST', bodySHA256: createHash('sha256').update(Buffer.from(submission.body, 'base64')).digest('hex'), contentType: submission.contentType ?? null }
}
