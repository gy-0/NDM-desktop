import type { AppUpdateReply } from '../shared/appUpdate'

const endpoint = 'https://api.github.com/repos/gy-0/NDM-desktop/releases/latest'
const maximumReplyBytes = 256 * 1024
function versionParts(value: string): number[] | null {
  if (!/^v?\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value)) return null
  return value.replace(/^v/, '').split('.').map(Number)
}
export function publicReleaseReply(value: unknown, currentVersion: string, checkedAt: number): AppUpdateReply {
  if (!value || typeof value !== 'object') return { status: 'error', reason: 'invalid' }
  const release = value as Record<string, unknown>
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string'
    || !release.tag_name.trim() || release.tag_name.length > 128 || /[\x00-\x1f\x7f]/.test(release.tag_name)
    || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) {
    return { status: 'error', reason: 'invalid' }
  }
  const version = release.tag_name
  const latest = versionParts(version), current = versionParts(currentVersion)
  let relation: 'newer' | 'current' | 'older' | 'unknown' = 'unknown'
  if (latest && current) {
    const index = latest.findIndex((part, i) => part !== current[i])
    relation = index < 0 ? 'current' : latest[index] > current[index] ? 'newer' : 'older'
  }
  return { status: 'release', checkedAt, version, relation,
    url: `https://github.com/gy-0/NDM-desktop/releases/tag/${encodeURIComponent(version)}` }
}

/** Explicit user action only. No telemetry, cookies, credentials or task data. */
export function createAppUpdateChecker(currentVersion: string, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch) {
  let pending: Promise<AppUpdateReply> | null = null
  const check = async (): Promise<AppUpdateReply> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetcher(endpoint, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NDM-Desktop' } })
      if (response.status === 404) { await response.body?.cancel(); return { status: 'unpublished', checkedAt: Date.now() } }
      if (response.status === 403 || response.status === 429) { await response.body?.cancel(); return { status: 'error', reason: 'rateLimit' } }
      if (!response.ok || !response.body) { await response.body?.cancel(); return { status: 'error', reason: 'network' } }
      const reader = response.body.getReader()
      let size = 0, text = ''
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maximumReplyBytes) { await reader.cancel(); return { status: 'error', reason: 'invalid' } }
          text += decoder.decode(chunk.value, { stream: true })
        }
      } finally { reader.releaseLock() }
      text += decoder.decode()
      try { return publicReleaseReply(JSON.parse(text), currentVersion, Date.now()) }
      catch { return { status: 'error', reason: 'invalid' } }
    } catch { return { status: 'error', reason: 'network' } }
    finally { clearTimeout(timeout) }
  }
  return (): Promise<AppUpdateReply> => {
    if (!pending) pending = check().finally(() => { pending = null })
    return pending
  }
}
