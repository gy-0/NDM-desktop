import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { browserLabel, parseBrowserSelection, profileLabel, PROFILE_BROWSERS, type BrowserSessionCatalog, type BrowserSessionSource, type SessionBrowserID } from '../shared/browserSessions'

type Dependencies = {
  localState: (browser: SessionBrowserID) => Promise<unknown>
  hasCookies: (browser: SessionBrowserID, profile: string) => Promise<boolean>
}
function browserRoot(browser: SessionBrowserID): string | null {
  const mac: Partial<Record<SessionBrowserID, string>> = { chrome: 'Google/Chrome', edge: 'Microsoft Edge', brave: 'BraveSoftware/Brave-Browser', chromium: 'Chromium', whale: 'Naver/Whale' }
  const win: Partial<Record<SessionBrowserID, string>> = { chrome: 'Google/Chrome/User Data', edge: 'Microsoft/Edge/User Data', brave: 'BraveSoftware/Brave-Browser/User Data', chromium: 'Chromium/User Data', whale: 'Naver/Naver Whale/User Data' }
  const linux: Partial<Record<SessionBrowserID, string>> = { chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'BraveSoftware/Brave-Browser', chromium: 'chromium', whale: 'naver-whale' }
  const suffix = (process.platform === 'darwin' ? mac : process.platform === 'win32' ? win : linux)[browser]
  if (!suffix) return null
  const base = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return base ? join(base, suffix) : null
}
const defaultDependencies: Dependencies = {
  async localState(browser) {
    const root = browserRoot(browser)
    if (!root) return null
    const file = await open(join(root, 'Local State'), constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 8 * 1024 * 1024) return null
      const buffer = Buffer.alloc(info.size + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead !== info.size) return null
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    } finally { await file.close() }
  },
  async hasCookies(browser, profile) {
    const root = browserRoot(browser)
    if (!root) return false
    // Only metadata for a Local State-listed profile; never open its Cookies DB.
    for (const relative of ['Cookies', 'Network/Cookies']) {
      try { if ((await stat(join(root, profile, relative))).isFile()) return true } catch { /* Not this location. */ }
    }
    return false
  }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export class BrowserSessionSelectionError extends Error {
  constructor(public readonly code: NonNullable<BrowserSessionCatalog['code']>, message: string) { super(message) }
}
export class BrowserSessionsService {
  constructor(private readonly dependencies: Dependencies = defaultDependencies) {}
  async catalog(selection: unknown): Promise<BrowserSessionCatalog> {
    const choice = parseBrowserSelection(selection)
    if (!choice) return { browser: 'chrome', profiles: [], code: 'invalidChoice', error: '请选择受支持的浏览器和个人资料。' }
    const { browser, profile } = choice, label = browserLabel(browser)
    if (!PROFILE_BROWSERS.includes(browser as typeof PROFILE_BROWSERS[number])) {
      return { browser, profiles: [], source: { browser, selector: browser, label: `${label} · 浏览器默认资料`, selection: 'browserDefault' } }
    }
    const unavailable: BrowserSessionCatalog = { browser, profiles: [], code: 'noBrowserData', error: `未找到 ${label} 的可用个人资料。请先打开该浏览器，并在需要下载的网站登录。` }
    let state: unknown
    try { state = await this.dependencies.localState(browser) } catch { return unavailable }
    if (!object(state) || !object(state.profile) || !object(state.profile.info_cache)) return unavailable
    const info = state.profile, ids = Object.keys(info.info_cache as object).filter(id => parseBrowserSelection(`${browser}:${id}`))
    const usable = (await Promise.all(ids.map(async id => await this.dependencies.hasCookies(browser, id) ? id : null))).filter((id): id is string => id !== null)
    const active = Array.isArray(info.last_active_profiles) ? [...new Set(info.last_active_profiles.filter((id): id is string => typeof id === 'string'))] : []
    const recent = typeof info.last_used === 'string' ? info.last_used : undefined
    const current = active.length === 1 ? active[0] : active.length === 0 ? recent : undefined
    const profiles = usable.map(id => {
      const entry = (info.info_cache as Record<string, unknown>)[id]
      const name = object(entry) && typeof entry.name === 'string'
        ? entry.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) : ''
      return { id, label: name || profileLabel(id), current: id === current }
    })
    const selected = profile ?? current
    if (!selected || !usable.includes(selected)) return { browser, profiles, code: profile ? 'noBrowserData' : 'profileSelectionRequired',
      error: profile ? `${label} 的所选个人资料不可用，请打开此资料后重试，或在高级选项中重新选择。` : `无法确定 ${label} 正在使用哪个个人资料，请在高级选项中选择当前登录的资料。` }
    return { browser, profiles, source: { browser, profile: selected, selector: `${browser}:${selected}`,
      label: `${label} · ${profiles.find(item => item.id === selected)!.label}`, selection: profile ? 'manual' : 'automatic' } }
  }
  async resolve(selection: unknown): Promise<BrowserSessionSource> {
    const result = await this.catalog(selection)
    if (!result.source) throw new BrowserSessionSelectionError(result.code ?? 'noBrowserData', result.error ?? '无法确定浏览器登录来源。')
    return result.source
  }
}
export const browserSessions = new BrowserSessionsService()
