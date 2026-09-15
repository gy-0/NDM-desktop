import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserLabel, parseBrowserSelection, profileLabel, PROFILE_BROWSERS, type BrowserSessionCatalog, type BrowserSessionSource, type SessionBrowserID, type BrowserSessionReadStage, type BrowserSessionEnvironment } from '../shared/browserSessions'
import { readBrowserStateFile, browserStateFailureCause, browserStateFailureStage, BrowserStateReadError, type BrowserStateFailureCause } from './browserStateFile'

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
/** Compare the two runtime home sources without exposing either path to the UI. */
export function browserSessionEnvironment(selection: unknown, appHome?: string): BrowserSessionEnvironment {
  const choice = parseBrowserSelection(selection)
  let home: string | undefined, rootResolved = false
  try { home = homedir(); rootResolved = !!choice && browserRoot(choice.browser) !== null } catch { /* Safe unresolved metadata. */ }
  return { rootResolved, homeResolved: !!home, homeMatchesAppHome: home && appHome ? resolve(home) === resolve(appHome) : null }
}
const defaultDependencies: Dependencies = {
  async localState(browser) {
    const root = browserRoot(browser)
    if (!root) throw new BrowserStateReadError('ENOENT', 'resolve')
    return readBrowserStateFile(join(root, 'Local State'))
  },
  async hasCookies(browser, profile) {
    const root = browserRoot(browser)
    if (!root) return false
    // Only metadata for a Local State-listed profile; never open its Cookies DB.
    let failure: BrowserStateFailureCause | undefined
    for (const relative of ['Cookies', 'Network/Cookies']) {
      try { if ((await stat(join(root, profile, relative))).isFile()) return true }
      catch (error) {
        const cause = browserStateFailureCause(error)
        if (!['ENOENT', 'ENOTDIR'].includes(cause)) failure = cause
      }
    }
    if (failure) throw new BrowserStateReadError(failure, 'stat')
    return false
  }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function readFailure(browser: SessionBrowserID, cause: BrowserStateFailureCause, stage: BrowserSessionReadStage, profiles: BrowserSessionCatalog['profiles'] = []): BrowserSessionCatalog {
  const label = browserLabel(browser)
  if (cause === 'ENOENT' || cause === 'ENOTDIR') return { browser, profiles, code: 'noBrowserData', cause, stage,
    error: `未找到 ${label} 的个人资料文件。请先打开该浏览器，再重新检测。` }
  if (cause === 'EACCES' || cause === 'EPERM') return { browser, profiles, code: 'browserAccessDenied', cause, stage,
    error: `系统拒绝 NDM 读取 ${label} 的个人资料。请检查系统隐私与安全性中的文件访问授权，再重新检测；也可从原网页通过 NDM Relay 发送下载。` }
  if (cause === 'changed') return { browser, profiles, code: 'browserDataChanged', cause, stage,
    error: `${label} 正在更新个人资料文件，请稍后重新检测；不会改用其他个人资料。` }
  if (['malformed', 'tooLarge', 'notRegular'].includes(cause)) return { browser, profiles, code: 'browserDataInvalid', cause, stage,
    error: `${label} 的个人资料文件暂时无法识别。请稍后重新检测，或从原网页通过 NDM Relay 发送下载。` }
  return { browser, profiles, code: 'browserReadFailed', cause, stage,
    error: `NDM 暂时无法读取 ${label} 的个人资料。请重新检测；若仍失败，可重启 NDM 后再试。` }
}
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
    try { state = await this.dependencies.localState(browser) } catch (error) { return readFailure(browser, browserStateFailureCause(error), browserStateFailureStage(error)) }
    if (state === null) return unavailable
    if (!object(state) || !object(state.profile) || !object(state.profile.info_cache)) return readFailure(browser, 'malformed', 'shape')
    const info = state.profile, ids = Object.keys(info.info_cache as object).filter(id => parseBrowserSelection(`${browser}:${id}`))
    const failures = new Map<string, BrowserStateFailureCause>()
    const usable = (await Promise.all(ids.map(async id => {
      try { return await this.dependencies.hasCookies(browser, id) ? id : null }
      catch (error) { failures.set(id, browserStateFailureCause(error)); return null }
    }))).filter((id): id is string => id !== null)
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
    if (selected && failures.has(selected)) return readFailure(browser, failures.get(selected)!, 'stat', profiles)
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
