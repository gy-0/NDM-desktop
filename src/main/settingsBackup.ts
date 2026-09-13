import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, posix, win32 } from 'node:path'
import {
  buildSettingsBackup, parseSettingsBackup, selectBackupSettings, settingsBackupChanges,
  SETTINGS_BACKUP_MAX_BYTES,
  type SettingsBackupKey, type SettingsBackupPreview, type SettingsBackupReply, type SettingsBackupValues
} from '../shared/settingsBackup'

export interface SettingsBackupDependencies {
  appVersion: string
  /** Return the settings object, not the engine reply envelope. */
  getSettings: () => Promise<unknown>
  /** A partial patch; omitted settings and credentials must be preserved. */
  updateSettings: (patch: SettingsBackupValues) => Promise<unknown>
  chooseExportPath: () => Promise<string | null>
  chooseImportPath: () => Promise<string | null>
  readTextFile?: (path: string, maxBytes: number) => Promise<string>
  writeTextFile?: (path: string, content: string) => Promise<void>
  platform?: NodeJS.Platform
  now?: () => number
}

const PREVIEW_LIFETIME_MS = 10 * 60 * 1000

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('备份文件必须是小于 256 KB 的普通文件。')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new Error('备份文件超过 256 KB 限制。')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } finally { await file.close() }
}

async function writeAtomicText(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.ndm-settings-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
    await file.close()
    await rename(temporary, path)
  } finally {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

function patchFromChanges(preview: SettingsBackupPreview, side: 'before' | 'after'): SettingsBackupValues {
  return Object.fromEntries(preview.changes.map(change => [change.key, change[side]])) as SettingsBackupValues
}

function matches(settings: SettingsBackupValues, expected: SettingsBackupValues): boolean {
  return (Object.keys(expected) as SettingsBackupKey[]).every(key => settings[key] === expected[key])
}

/**
 * Serializes this service's operations. Preview never updates settings.
 * Apply is one partial engine update followed by read-back verification, with
 * compensating restoration on failure; the engine exposes no true transaction.
 * Engine side effects (for example already-started queued tasks) are not undone.
 */
export class SettingsBackupService {
  private tail: Promise<void> = Promise.resolve()
  private preview: SettingsBackupPreview | null = null
  private readonly now: () => number

  constructor(private readonly dependencies: SettingsBackupDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  request(op: string, extra: Record<string, unknown> = {}): Promise<SettingsBackupReply> {
    const operation = this.tail.then(async (): Promise<SettingsBackupReply> => {
      switch (op) {
        case 'settingsBackupExport': return this.exportBackup()
        case 'settingsBackupPreview': return this.previewBackup()
        case 'settingsBackupApply': return this.applyBackup(extra.token)
        default: return { ok: false, error: '不支持的设置备份操作。' }
      }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation.catch(() => ({ ok: false, error: '设置备份操作失败，请确认文件权限和下载引擎状态后重试。' }))
  }

  private async currentSettings(): Promise<SettingsBackupValues> {
    const settings = selectBackupSettings(await this.dependencies.getSettings())
    if (!Object.keys(settings).length) throw new Error('下载引擎没有返回可用设置。')
    return settings
  }

  private async exportBackup(): Promise<SettingsBackupReply> {
    const backup = buildSettingsBackup(await this.currentSettings(), this.dependencies.appVersion, new Date(this.now()).toISOString())
    const path = await this.dependencies.chooseExportPath()
    if (!path) return { ok: true, cancelled: true }
    const content = `${JSON.stringify(backup, null, 2)}\n`
    await (this.dependencies.writeTextFile ?? writeAtomicText)(path, content)
    return { ok: true, exported: true, filename: basename(path) }
  }

  private async previewBackup(): Promise<SettingsBackupReply> {
    // Choosing another file invalidates the preceding confirmation.
    this.preview = null
    const path = await this.dependencies.chooseImportPath()
    if (!path) return { ok: true, cancelled: true }
    let content: string
    try { content = await (this.dependencies.readTextFile ?? readBoundedText)(path, SETTINGS_BACKUP_MAX_BYTES) }
    catch { return { ok: false, error: '无法读取备份。请选择不超过 256 KB 的 UTF-8 JSON 文件。' } }
    let parsed: ReturnType<typeof parseSettingsBackup>
    try { parsed = parseSettingsBackup(content) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '备份格式无效。' } }
    const before = await this.currentSettings()
    const after: SettingsBackupValues = {}
    const notes: string[] = []
    let ignoredCount = parsed.ignoredCount
    for (const [rawKey, value] of Object.entries(parsed.backup.settings)) {
      const key = rawKey as SettingsBackupKey
      if (before[key] === undefined) { ignoredCount++; continue }
      if (key === 'downloadDirectory') {
        const platform = this.dependencies.platform ?? process.platform
        const pathValue = String(value)
        const compatible = platform === 'win32'
          ? win32.isAbsolute(pathValue) && (/^[a-z]:[\\/]/i.test(pathValue) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(pathValue))
          : posix.isAbsolute(pathValue)
        if (!compatible) {
          ignoredCount++
          notes.push('备份中的下载目录不适用于当前系统，保留本机目录。')
          continue
        }
      }
      if (key === 'maxConnections' && (this.dependencies.platform ?? process.platform) === 'win32' && Number(value) > 16) {
        after[key] = 16
        notes.push('此设备的下载引擎最多支持 16 个连接，预览已按 16 个连接显示。')
      } else { after[key] = value }
    }
    const changes = settingsBackupChanges(before, after)
    if (changes.some(change => change.key === 'downloadAllAtOnce' && change.after === true)) {
      notes.push('开启同时下载会启动正在等待的任务；恢复设置不会撤回已启动的任务。')
    }
    const preview: SettingsBackupPreview = {
      token: randomUUID(), filename: basename(path), changes, ignoredCount, notes,
      expiresAt: this.now() + PREVIEW_LIFETIME_MS
    }
    // Never trust renderer-supplied settings or file paths during confirmation.
    this.preview = structuredClone(preview)
    return { ok: true, preview }
  }

  private async applyBackup(token: unknown): Promise<SettingsBackupReply> {
    const preview = this.preview
    if (typeof token !== 'string' || !preview || token !== preview.token || this.now() >= preview.expiresAt) {
      return { ok: false, error: '导入预览已失效，请重新选择备份文件。', rollback: 'not-needed' }
    }
    this.preview = null
    const previous = patchFromChanges(preview, 'before')
    const desired = patchFromChanges(preview, 'after')
    const current = await this.currentSettings()
    if (!matches(current, previous)) {
      return { ok: false, error: '预览后设置已被修改，请重新预览再确认。', rollback: 'not-needed' }
    }
    if (!preview.changes.length) return { ok: true, applied: true, changedCount: 0 }
    try {
      const reply = await this.dependencies.updateSettings(desired)
      if (reply && typeof reply === 'object' && 'ok' in reply && reply.ok === false) throw new Error('engine rejected settings')
      if (matches(await this.currentSettings(), desired)) {
        return { ok: true, applied: true, changedCount: preview.changes.length }
      }
    } catch { /* An error reply can follow a partial update. Verify and restore. */ }

    let observed: SettingsBackupValues
    try { observed = await this.currentSettings() }
    catch {
      return { ok: false, error: '导入失败，且无法读取设置以确认恢复。请检查下载引擎后核对设置。', rollback: 'failed', recoveryRequired: true,
        unrestoredKeys: preview.changes.map(change => change.key) }
    }
    const restore: SettingsBackupValues = {}
    // Do not overwrite a newer external edit when its value differs from both
    // the requested value and the preview's original value.
    for (const change of preview.changes) {
      if (observed[change.key] === change.after) restore[change.key] = change.before
    }
    const attemptedRestore = Object.keys(restore).length > 0
    if (attemptedRestore) {
      try { await this.dependencies.updateSettings(restore) } catch { /* Read back even after a lost reply. */ }
    }
    try {
      const restored = await this.currentSettings()
      const unrestoredKeys = preview.changes.filter(change => restored[change.key] !== change.before).map(change => change.key)
      if (!unrestoredKeys.length) {
        return { ok: false, error: attemptedRestore ? '导入未完成，已恢复原设置。' : '下载引擎未应用这些更改，原设置保持不变。',
          rollback: attemptedRestore ? 'succeeded' : 'not-needed' }
      }
      return { ok: false, error: '导入未完成，部分设置未能恢复。请按预览中的原值核对设置。', rollback: 'partial', recoveryRequired: true, unrestoredKeys }
    } catch {
      return { ok: false, error: '导入未完成，无法确认设置是否恢复。请检查下载引擎后核对设置。', rollback: 'failed', recoveryRequired: true,
        unrestoredKeys: preview.changes.map(change => change.key) }
    }
  }
}
