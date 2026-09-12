import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EXPORT_TIMEOUT_MS = 20000

/** Locate the bundled yt-dlp binary the same way the engine locates its tools. */
export function findYtDlp(): string | null {
  const candidates = process.platform === 'darwin'
    ? [
        join(process.resourcesPath ?? '', 'Tools', 'yt-dlp'),
        join(process.cwd(), 'native', 'Vendor', 'Tools', 'yt-dlp')
      ]
    : [
        join(process.resourcesPath ?? '', 'Tools', 'windows', 'yt-dlp.exe'),
        join(process.cwd(), 'vendor', 'windows', 'yt-dlp.exe')
      ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

type NetscapeRow = {
  domain: string
  flag: boolean
  path: string
  secure: boolean
  expiry: number
  name: string
  value: string
}

export function parseNetscapeCookieFile(content: string): NetscapeRow[] {
  const rows: NetscapeRow[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const parts = line.replace(/^#HttpOnly_/, '').split('\t')
    if (parts.length < 7) continue
    const [domain, flag, path, secure, expiry, name, value] = parts
    rows.push({
      domain: domain.trim(),
      flag: flag === 'TRUE',
      path: path.trim(),
      secure: secure === 'TRUE',
      expiry: Number(expiry) || 0,
      name: name.trim(),
      value
    })
  }
  return rows
}

/**
 * Cookie domain matching per RFC 6265: an exact host match, or a dot-prefixed
 * domain that matches the host or any of its parent domains.
 */
export function cookieMatchesHost(cookieDomain: string, host: string): boolean {
  const normalizedHost = host.toLowerCase()
  const normalizedCookie = cookieDomain.toLowerCase()
  if (normalizedCookie.startsWith('.')) {
    const bare = normalizedCookie.slice(1)
    return normalizedHost === bare || normalizedHost.endsWith(`.${bare}`)
  }
  return normalizedHost === normalizedCookie
}

/** Keep only cookies whose domain matches the target URL's host or its parents. */
export function cookiesForURL(rows: NetscapeRow[], rawURL: string): NetscapeRow[] {
  let target: URL
  try {
    target = new URL(rawURL)
  } catch {
    return []
  }
  const now = Date.now() / 1000
  return rows.filter((row) => {
    const path = row.path || '/'
    return cookieMatchesHost(row.domain, target.hostname)
      && (!row.secure || target.protocol === 'https:')
      && (row.expiry === 0 || row.expiry > now)
      && (target.pathname === path || (target.pathname.startsWith(path)
        && (path.endsWith('/') || target.pathname[path.length] === '/')))
  }).sort((left, right) => right.path.length - left.path.length)
}

export function rowsToCookieHeader(rows: NetscapeRow[]): string {
  if (rows.length === 0) return ''
  return rows.map((row) => `${row.name}=${row.value}`).join('; ')
}

function runYtDlpExport(binary: string, browser: string, cookieFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The target URL only primes yt-dlp's option parser; the cookie jar is
    // written before any network request, and an unsupported scheme exits
    // right after dumping the session — which is exactly the fast path here.
    const child = spawn(binary, [
      '--ignore-config',
      '--cookies-from-browser', browser,
      '--cookies', cookieFile,
      '--no-warnings',
      '--skip-download', '--', 'ndm-cookie-export:'
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('读取浏览器会话超时'))
    }, EXPORT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 yt-dlp：${error.message}`))
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (existsSync(cookieFile)) {
        resolve()
        return
      }
      const message = stderr.includes('could not find')
        ? '未找到该浏览器的本地数据，请确认已安装并登录过'
        : stderr.trim().split('\n').pop() || '无法读取浏览器会话'
      reject(new Error(`无法读取浏览器会话：${message}`))
    })
  })
}

export type CookieExport = { header: string }

// Exporting a browser jar costs ~16 s (yt-dlp profile read), so identical
// requests inside a short window reuse the previous answer instead of paying
// that cost on every classify retry. Only the derived header is cached, never
// the jar file, and values still never reach logs or task state.
const CACHE_TTL_MS = 5 * 60_000
const cookieCache = new Map<string, { header: string; expiresAt: number }>()

/**
 * Export the given browser's cookie jar and return a Cookie header scoped to
 * the target URL's domain. The jar file lives in a private temp directory and
 * is deleted before this resolves; values never reach logs or task state.
 */
export async function exportCookieHeader(
  targetURL: string,
  browser: string
): Promise<CookieExport> {
  let host = ''
  try {
    host = new URL(targetURL).hostname.toLowerCase()
  } catch {
    throw new Error('无效的目标地址')
  }
  const target = new URL(targetURL)
  const cacheKey = `${browser}::${target.protocol}//${host}${target.pathname}`
  const cached = cookieCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { header: cached.header }
  }
  const binary = findYtDlp()
  if (!binary) throw new Error('未找到 yt-dlp 工具，无法读取浏览器会话')
  const dir = await mkdtemp(join(tmpdir(), 'ndm-cookies-'))
  const cookieFile = join(dir, 'cookies.txt')
  try {
    await runYtDlpExport(binary, browser, cookieFile)
    const content = await readFile(cookieFile, 'utf8')
    const scoped = cookiesForURL(parseNetscapeCookieFile(content), targetURL)
    const header = rowsToCookieHeader(scoped)
    if (!header) throw new Error('该浏览器没有与这个网站匹配的会话 Cookie，请先在浏览器里登录')
    cookieCache.set(cacheKey, { header, expiresAt: Date.now() + CACHE_TTL_MS })
    return { header }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
