/**
 * Settings backup envelope adapted from Motrix Next (MIT).
 * Copyright (c) 2025-present AnInsomniacy. Full notice: THIRD_PARTY.md.
 * Source: src/shared/utils/settingsBackup.ts at
 * https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/src/shared/utils/settingsBackup.ts
 * NDM uses its own format, a portable allowlist, strict validation and no secrets.
 */

export const SETTINGS_BACKUP_FORMAT = 'ndm-settings'
export const SETTINGS_BACKUP_VERSION = 1
export const SETTINGS_BACKUP_MAX_BYTES = 256 * 1024

export const SETTINGS_BACKUP_LABELS = {
  downloadDirectory: '下载目录',
  maxConnections: '每个任务的连接数',
  bandwidthLimitBytesPerSecond: '下载限速',
  askBrowserDownloadDestination: '浏览器下载时询问保存位置',
  useCategoryFolders: '按文件类型分目录',
  downloadAllAtOnce: '同时下载多个任务',
  smartConnections: '智能连接控制',
  installerSourceDisposition: '安装完成后的源文件处理'
} as const

export type SettingsBackupKey = keyof typeof SETTINGS_BACKUP_LABELS
export type SettingsBackupValue = string | number | boolean
export type SettingsBackupValues = Partial<Record<SettingsBackupKey, SettingsBackupValue>>

export interface SettingsBackupFile {
  format: typeof SETTINGS_BACKUP_FORMAT
  version: typeof SETTINGS_BACKUP_VERSION
  appVersion: string
  exportedAt: string
  settings: SettingsBackupValues
}

export interface SettingsBackupChange {
  key: SettingsBackupKey
  label: string
  before: SettingsBackupValue
  after: SettingsBackupValue
}

export interface SettingsBackupPreview {
  token: string
  filename: string
  changes: SettingsBackupChange[]
  ignoredCount: number
  notes: string[]
  expiresAt: number
}

export type SettingsBackupReply =
  | { ok: true; cancelled: true }
  | { ok: true; filename: string; exported: true }
  | { ok: true; preview: SettingsBackupPreview }
  | { ok: true; applied: true; changedCount: number }
  | { ok: false; error: string; rollback?: 'not-needed' | 'succeeded' | 'partial' | 'failed'; recoveryRequired?: boolean; unrestoredKeys?: SettingsBackupKey[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isValidValue(key: SettingsBackupKey, value: unknown): value is SettingsBackupValue {
  switch (key) {
    case 'downloadDirectory':
      return typeof value === 'string' && value.length > 0 && value.length <= 4096
        && !/[\u0000-\u001f\u007f]/.test(value)
        && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
    case 'maxConnections':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 32
    case 'bandwidthLimitBytesPerSecond':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    case 'installerSourceDisposition':
      return value === 'ask' || value === 'trash' || value === 'keep'
    default:
      return typeof value === 'boolean'
  }
}

/** Never copy arbitrary properties, nested values, proxy endpoints or credentials. */
export function selectBackupSettings(value: unknown): SettingsBackupValues {
  if (!isRecord(value)) throw new Error('无法读取有效的下载设置。')
  const settings: SettingsBackupValues = {}
  for (const key of Object.keys(SETTINGS_BACKUP_LABELS) as SettingsBackupKey[]) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue
    if (!isValidValue(key, value[key])) throw new Error(`${SETTINGS_BACKUP_LABELS[key]}的值无效。`)
    settings[key] = value[key]
  }
  return settings
}

function checkStructure(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++visited > 4096 || entry.depth > 12) throw new Error('备份文件结构过于复杂。')
    if (entry.value === null || typeof entry.value !== 'object') continue
    for (const [key, child] of Object.entries(entry.value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error('备份文件包含不允许的属性。')
      }
      pending.push({ value: child, depth: entry.depth + 1 })
    }
  }
}

export function buildSettingsBackup(config: unknown, appVersion: string, exportedAt = new Date().toISOString()): SettingsBackupFile {
  if (typeof appVersion !== 'string' || !appVersion || appVersion.length > 128 || /[\u0000-\u001f\u007f]/.test(appVersion)) {
    throw new Error('无法读取应用版本。')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(exportedAt) || !Number.isFinite(Date.parse(exportedAt))) {
    throw new Error('备份时间无效。')
  }
  const settings = selectBackupSettings(config)
  if (!Object.keys(settings).length) throw new Error('没有可备份的下载设置。')
  return { format: SETTINGS_BACKUP_FORMAT, version: SETTINGS_BACKUP_VERSION, appVersion, exportedAt, settings }
}

export function parseSettingsBackup(content: string): { backup: SettingsBackupFile; ignoredCount: number } {
  if (typeof content !== 'string' || content.length > SETTINGS_BACKUP_MAX_BYTES
      || new TextEncoder().encode(content).byteLength > SETTINGS_BACKUP_MAX_BYTES) {
    throw new Error('备份文件超过 256 KB 限制。')
  }
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { throw new Error('备份文件不是有效的 JSON。') }
  checkStructure(parsed)
  if (!isRecord(parsed) || parsed.format !== SETTINGS_BACKUP_FORMAT || parsed.version !== SETTINGS_BACKUP_VERSION
      || !isRecord(parsed.settings) || typeof parsed.appVersion !== 'string' || typeof parsed.exportedAt !== 'string') {
    throw new Error('请选择受支持的 NDM 设置备份（版本 1）。')
  }
  const backup = buildSettingsBackup(parsed.settings, parsed.appVersion, parsed.exportedAt)
  const ignoredCount = Object.keys(parsed.settings).filter(key => !Object.hasOwn(SETTINGS_BACKUP_LABELS, key)).length
  return { backup, ignoredCount }
}

export function settingsBackupChanges(before: SettingsBackupValues, after: SettingsBackupValues): SettingsBackupChange[] {
  return (Object.keys(SETTINGS_BACKUP_LABELS) as SettingsBackupKey[]).flatMap(key => {
    const previous = before[key], next = after[key]
    return previous !== undefined && next !== undefined && previous !== next
      ? [{ key, label: SETTINGS_BACKUP_LABELS[key], before: previous, after: next }]
      : []
  })
}

export function formatBackupValue(key: SettingsBackupKey, value: SettingsBackupValue): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (key === 'installerSourceDisposition') return value === 'trash' ? '移到废纸篓' : value === 'keep' ? '保留' : '每次询问'
  if (key === 'bandwidthLimitBytesPerSecond' && typeof value === 'number') {
    return value === 0 ? '不限速' : value >= 1_048_576 ? `${Number((value / 1_048_576).toFixed(2))} MB/s` : `${value} B/s`
  }
  return String(value)
}
