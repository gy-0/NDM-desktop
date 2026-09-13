/**
 * aria2 error-code mapping adapted from Motrix Next (MIT).
 * Copyright (c) 2025-present AnInsomniacy
 * Source: src/shared/aria2ErrorCodes.ts at
 * https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/src/shared/aria2ErrorCodes.ts
 * Full license: THIRD_PARTY.md. NDM adds Chinese recovery guidance and redaction.
 * Codes 0 (finished) and 31 (removed/reserved) remain outside this mapping.
 */

const ARIA2_ERROR_CODES = {
  '1': 'task.error-unknown',
  '2': 'task.error-timeout',
  '3': 'task.error-not-found',
  '4': 'task.error-max-file-not-found',
  '5': 'task.error-too-slow',
  '6': 'task.error-network',
  '7': 'task.error-unfinished',
  '8': 'task.error-resume-failed',
  '9': 'task.error-disk-full',
  '10': 'task.error-piece-length',
  '11': 'task.error-duplicate-file',
  '12': 'task.error-duplicate-torrent',
  '13': 'task.error-file-exists',
  '14': 'task.error-rename-failed',
  '15': 'task.error-file-open',
  '16': 'task.error-file-create',
  '17': 'task.error-io',
  '18': 'task.error-dir-create',
  '19': 'task.error-dns',
  '22': 'task.error-http-response',
  '23': 'task.error-too-many-redirects',
  '24': 'task.error-http-auth',
  '25': 'task.error-bencode-parse',
  '26': 'task.error-torrent-corrupt',
  '27': 'task.error-magnet-bad',
  '28': 'task.error-bad-option',
  '29': 'task.error-server-unavailable',
  '30': 'task.error-json-rpc-parse',
  '32': 'task.error-checksum'
} as const

type Aria2ErrorKey = typeof ARIA2_ERROR_CODES[keyof typeof ARIA2_ERROR_CODES]

const ERROR_MESSAGES: Record<Aria2ErrorKey, string> = {
  'task.error-unknown': '下载引擎遇到未知错误。请稍后重试，仍失败时根据错误详情排查。',
  'task.error-timeout': '连接或传输超时。请检查网络和代理设置后重试。',
  'task.error-not-found': '资源未找到。请确认原站文件仍存在，或更新下载地址。',
  'task.error-max-file-not-found': '服务器多次返回资源不存在。请核对下载地址后重试。',
  'task.error-too-slow': '下载速度持续低于引擎要求。请更换下载来源或稍后重试。',
  'task.error-network': '网络连接失败。请检查网络和代理设置后重试。',
  'task.error-unfinished': '下载尚未完成。请恢复任务继续下载。',
  'task.error-resume-failed': '无法从当前断点继续下载。请确认下载地址仍有效，必要时重新下载。',
  'task.error-disk-full': '保存位置空间不足。请释放磁盘空间或更换保存位置后重试。',
  'task.error-piece-length': '下载分片与续传记录不一致。请确认资源未改变，再重新下载。',
  'task.error-duplicate-file': '已有任务正在写入同一文件。请继续现有任务，或更换文件名。',
  'task.error-duplicate-torrent': '同一种子已经存在下载任务。请查看并继续现有任务。',
  'task.error-file-exists': '目标文件已存在。请更换文件名或保存位置，保留已有文件。',
  'task.error-rename-failed': '文件重命名失败。请检查文件是否被占用及目录权限。',
  'task.error-file-open': '无法打开目标文件。请检查文件占用、访问权限及磁盘连接。',
  'task.error-file-create': '无法创建或调整目标文件。请检查保存目录权限及磁盘可用空间。',
  'task.error-io': '读写文件失败。请检查磁盘连接、可用空间和文件权限。',
  'task.error-dir-create': '无法创建保存目录。请检查路径和访问权限，或更换保存位置。',
  'task.error-dns': '无法解析服务器地址。请检查网络、DNS 或代理设置。',
  'task.error-http-response': '服务器返回了异常 HTTP 响应。请确认下载地址和登录状态后重试。',
  'task.error-too-many-redirects': '重定向次数过多。请使用原站当前下载链接，避免循环跳转。',
  'task.error-http-auth': '服务器身份验证失败。请重新登录来源网站并更新下载链接或凭据。',
  'task.error-bencode-parse': '无法解析种子文件。请重新获取有效的 .torrent 文件。',
  'task.error-torrent-corrupt': '种子文件损坏或内容不完整。请重新获取种子文件。',
  'task.error-magnet-bad': '磁力链接格式无效。请复制完整的 magnet 链接后重试。',
  'task.error-bad-option': '下载参数无效或不受支持。请检查任务设置后重试。',
  'task.error-server-unavailable': '服务器暂时不可用。请稍后重试。',
  'task.error-json-rpc-parse': '下载引擎无法解析控制请求。请重启 NDM，仍失败时检查引擎版本。',
  'task.error-checksum': '下载文件校验失败。请重新下载，确认校验通过后再使用文件。'
}

const REDACTED = '[已隐藏]'
const MAX_ERROR_LENGTH = 2000

/**
 * Keep useful failure details without replaying request credentials into the UI
 * or task history. This is also used when exposing history written by old builds.
 * Redact before truncating so a partially retained credential cannot escape.
 */
export function sanitizeDownloadError(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const clean = message
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Drop the full header value, including folded lines and serialized header
    // objects. Values can contain spaces, semicolons, commas and nested quotes.
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=][^\n]*(?:\n[ \t]+[^\n]*)*/gi,
      (_match, name: string) => `${name}: ${REDACTED}`)
    .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9+/_=.-]+/gi, `$1 ${REDACTED}`)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, (url) => {
      // Textual removal also handles malformed URLs that URL() cannot parse.
      const withoutCredentials = url.replace(/(\/\/)[^/?#]*@/, '$1')
      const privatePart = withoutCredentials.search(/[?#]/)
      return privatePart < 0 ? withoutCredentials : `${withoutCredentials.slice(0, privatePart)}?${REDACTED}`
    })
    .trim()
  if (!clean) return undefined
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}…` : clean
}

/** Download status codes are distinct from JSON-RPC envelope error codes. */
export function formatAria2Error(errorCode: unknown, errorMessage?: unknown): string {
  const code = typeof errorCode === 'string' || typeof errorCode === 'number' ? String(errorCode).trim() : ''
  const key = Object.hasOwn(ARIA2_ERROR_CODES, code)
    ? ARIA2_ERROR_CODES[code as keyof typeof ARIA2_ERROR_CODES]
    : undefined
  const detail = sanitizeDownloadError(errorMessage)
  if (key) {
    const message = ERROR_MESSAGES[key]
    // aria2's generic error still needs its original, redacted explanation.
    return key === 'task.error-unknown' && detail ? `${message}\n详情：${detail}` : message
  }
  const label = /^\d{1,5}$/.test(code) ? `aria2 下载失败（错误码 ${code}）` : 'aria2 下载失败'
  return detail ? `${label}：${detail}` : `${label}。请稍后重试。`
}
