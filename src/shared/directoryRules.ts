/**
 * Extension extraction and first-match / combined-condition semantics adapted
 * from Motrix Next fileCategory.ts (MIT), Copyright (c) 2025-present AnInsomniacy.
 * https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/src/shared/utils/fileCategory.ts
 * Full notice: THIRD_PARTY.md. NDM uses bounded glob DP instead of regex.
 */
export const DIRECTORY_RULE_LIMITS = Object.freeze({ rules: 32, patterns: 8, patternLength: 256, patternCharacters: 8192, candidateLength: 4096, bytes: 65536 })
export type DirectoryRulesPlatform = 'win32' | 'posix'
export interface DirectoryRule { id: string; name: string; enabled: boolean; directory: string; hosts: string[]; pathGlobs: string[]; extensions: string[] }
export interface DirectoryRulesConfig { version: 1; enabled: boolean; rules: DirectoryRule[] }
export interface DirectoryRulesSample { url: string; filename?: string; explicitDirectory?: string }
export interface DirectoryRuleResolution { directory: string; source: 'explicit' | 'rule' | 'fallback'; ruleID?: string; ruleName?: string; ignoredRuleIDs?: string[] }
export type DirectoryRulesReply =
  | { ok: true; revision: number; config: DirectoryRulesConfig }
  | { ok: true; results: DirectoryRuleResolution[] }
  | { ok: true; directory: string | null }
  | { ok: false; error: string; code?: 'conflict' | 'storage' | 'apply'; recoveryRequired?: boolean }
export const defaultDirectoryRules = (): DirectoryRulesConfig => ({ version: 1, enabled: false, rules: [] })
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/
const invalid = (message: string): never => { throw new Error(message) }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('目录规则格式无效。')
  return value as Record<string, unknown>
}
const checkKeys = (value: Record<string, unknown>, allowed: string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('目录规则包含未知字段，请使用当前版本的配置。')
}

export function isDirectoryForPlatform(path: string, platform: DirectoryRulesPlatform): boolean {
  if (!path || path.length > 4096 || controlCharacters.test(path) || path !== path.trim()) return false
  if (path.split(/[\\/]/).some(part => part === '.' || part === '..')) return false
  if (platform === 'posix') return path.startsWith('/') && !path.startsWith('//')
  if (!/^[a-z]:[\\/]/i.test(path) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(path)) return false
  // Refuse drive-relative/device paths, ADS and names Windows normalizes away.
  const tail = /^[a-z]:/i.test(path) ? path.slice(2) : path.slice(2)
  return !/[<>:"|?*]/.test(tail) && !tail.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
}

export function validateDirectoryRules(value: unknown): DirectoryRulesConfig {
  const source = object(value)
  checkKeys(source, ['version', 'enabled', 'rules'])
  if (source.version !== 1 || typeof source.enabled !== 'boolean' || !Array.isArray(source.rules) || source.rules.length > DIRECTORY_RULE_LIMITS.rules) {
    return invalid('请选择版本 1 的目录规则，最多支持 32 条。')
  }
  const ids = new Set<string>()
  let totalPatternCharacters = 0
  const rules = source.rules.map((raw, index): DirectoryRule => {
    const row = object(raw), label = `第 ${index + 1} 条规则`
    checkKeys(row, ['id', 'name', 'enabled', 'directory', 'hosts', 'pathGlobs', 'extensions'])
    if (typeof row.id !== 'string' || !/^[a-z\d_-]{1,64}$/i.test(row.id) || ids.has(row.id)) return invalid(`${label}的标识无效或重复。`)
    ids.add(row.id)
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80 || controlCharacters.test(row.name)
        || typeof row.enabled !== 'boolean') return invalid(`${label}的名称或开关无效。`)
    if (typeof row.directory !== 'string' || (!isDirectoryForPlatform(row.directory, 'posix') && !isDirectoryForPlatform(row.directory, 'win32'))) {
      return invalid(`${label}必须选择明确的绝对目录，不能包含 . 或 .. 路径段。`)
    }
    const patterns = (key: 'hosts' | 'pathGlobs' | 'extensions'): string[] => {
      const items = row[key]
      if (!Array.isArray(items) || items.length > DIRECTORY_RULE_LIMITS.patterns) return invalid(`${label}的每组条件最多支持 8 项。`)
      return [...new Set(items.map(value => {
        if (typeof value !== 'string' || !value.trim() || value.length > DIRECTORY_RULE_LIMITS.patternLength || controlCharacters.test(value)) {
          return invalid(`${label}的匹配条件无效或超过 256 个字符。`)
        }
        let pattern = value.trim()
        if (key === 'hosts') {
          pattern = pattern.toLowerCase().replace(/\.$/, '')
          if (!/^[a-z\d*?.-]+$/.test(pattern) || pattern.includes('..')) return invalid(`${label}的主机条件只能使用域名、IPv4 和 *、?，不能包含协议、端口或登录信息。`)
        } else if (key === 'pathGlobs') {
          if (!pattern.startsWith('/') || pattern.includes('#') || pattern.includes('\\')) return invalid(`${label}的路径条件必须以 / 开头，不含片段或反斜杠。`)
        } else {
          pattern = pattern.toLowerCase().replace(/^\./, '')
          if (!/^[a-z\d][a-z\d_-]{0,31}$/.test(pattern)) return invalid(`${label}的扩展名只能是字母、数字、横线或下划线，例如 zip、pdf。`)
        }
        totalPatternCharacters += pattern.length
        return pattern
      }))]
    }
    const hosts = patterns('hosts'), pathGlobs = patterns('pathGlobs'), extensions = patterns('extensions')
    if (!hosts.length && !pathGlobs.length && !extensions.length) return invalid(`${label}至少需要一组匹配条件。`)
    return { id: row.id, name: row.name.trim(), enabled: row.enabled, directory: row.directory, hosts, pathGlobs, extensions }
  })
  const config: DirectoryRulesConfig = { version: 1, enabled: source.enabled, rules }
  if (totalPatternCharacters > DIRECTORY_RULE_LIMITS.patternCharacters || new TextEncoder().encode(JSON.stringify(config)).length > DIRECTORY_RULE_LIMITS.bytes) {
    return invalid('目录规则总长度超过限制，请减少规则或匹配条件。')
  }
  return config
}

/** Anchored glob: * is zero or more scalars; ? exactly one. No regex execution. */
export function directoryGlobMatches(pattern: string, candidate: string): boolean {
  if (pattern.length > DIRECTORY_RULE_LIMITS.patternLength || candidate.length > DIRECTORY_RULE_LIMITS.candidateLength) return false
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === candidate
  const mask = Array.from(pattern), text = Array.from(candidate)
  if (mask.filter(value => value !== '*').length > text.length) return false
  let previous = new Uint8Array(mask.length + 1)
  previous[0] = 1
  for (let i = 1; i <= mask.length && mask[i - 1] === '*'; i++) previous[i] = 1
  for (const character of text) {
    const next = new Uint8Array(mask.length + 1)
    for (let i = 1; i <= mask.length; i++) {
      next[i] = mask[i - 1] === '*' ? (next[i - 1] || previous[i]) : ((mask[i - 1] === '?' || mask[i - 1] === character) ? previous[i - 1] : 0)
    }
    previous = next
  }
  return previous[mask.length] === 1
}

/** Last extension only; dotfiles and a missing extension return an empty string. */
export function directoryRuleExtension(urlOrFilename: string): string {
  if (!urlOrFilename || /^(magnet|data|blob):/i.test(urlOrFilename)) return ''
  let pathname: string
  try { pathname = new URL(urlOrFilename).pathname }
  catch { pathname = urlOrFilename }
  let filename = pathname.split(/[\\/]/).pop() ?? ''
  try { filename = decodeURIComponent(filename) } catch { /* Keep malformed escapes literal. */ }
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/** Validate configuration at the boundary, then call once before task creation.
 * Caller computes fallbackDirectory using the existing category/default policy.
 * A matching rule is an exact directory override, never a category parent.
 */
export function resolveDirectoryRule(config: DirectoryRulesConfig, sample: DirectoryRulesSample & { fallbackDirectory: string; platform: DirectoryRulesPlatform }): DirectoryRuleResolution {
  if (sample.explicitDirectory?.trim()) {
    if (!isDirectoryForPlatform(sample.explicitDirectory, sample.platform)) return invalid('手动选择的目录不适用于当前系统。')
    return { directory: sample.explicitDirectory, source: 'explicit' }
  }
  if (!isDirectoryForPlatform(sample.fallbackDirectory, sample.platform)) return invalid('默认下载目录不适用于当前系统。')
  const fallback: DirectoryRuleResolution = { directory: sample.fallbackDirectory, source: 'fallback' }
  if (!config.enabled) return fallback
  let url: URL
  try { url = new URL(sample.url) } catch { return fallback }
  if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) return fallback
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const extension = directoryRuleExtension(sample.filename?.trim() ? sample.filename : sample.url)
  const ignoredRuleIDs: string[] = []
  for (const rule of config.rules) {
    if (!rule.enabled) continue
    if (!isDirectoryForPlatform(rule.directory, sample.platform)) { ignoredRuleIDs.push(rule.id); continue }
    if (!rule.hosts.length && !rule.pathGlobs.length && !rule.extensions.length) continue
    if (rule.hosts.length && !rule.hosts.some(pattern => directoryGlobMatches(pattern, host))) continue
    if (rule.pathGlobs.length && !rule.pathGlobs.some(pattern => directoryGlobMatches(pattern, url.pathname))) continue
    if (rule.extensions.length && !rule.extensions.includes(extension)) continue
    return { directory: rule.directory, source: 'rule', ruleID: rule.id, ruleName: rule.name, ...(ignoredRuleIDs.length ? { ignoredRuleIDs } : {}) }
  }
  return { ...fallback, ...(ignoredRuleIDs.length ? { ignoredRuleIDs } : {}) }
}
