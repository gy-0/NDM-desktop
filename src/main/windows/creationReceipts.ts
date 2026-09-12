import { createHash, randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type WindowsCreationReceipt = {
  creationKey: string
  intentDigest: string
  taskID: number
}

export function normalizeCreationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    throw new Error('添加操作标识无效，请重新打开添加窗口')
  }
  return value.toLowerCase()
}

/** Bind the user's request, not mutable defaults, cookies or resolved media URLs. */
export function creationIntentDigest(operation: 'add' | 'addMedia', extra: Record<string, unknown>): string {
  const text = (key: string): string | null => typeof extra[key] === 'string' ? extra[key].trim() || null : null
  const intent = operation === 'add'
    ? {
        operation, url: String(extra.url ?? '').trim(), filename: text('filename'),
        folderPath: text('folderPath'), connections: extra.connections == null ? null : Number(extra.connections),
        autoStart: extra.autoStart !== false,
        pageURL: text('pageURL'), mediaFormatID: text('mediaFormatID'),
        mediaOptions: extra.mediaOptions && typeof extra.mediaOptions === 'object'
          ? {
              container: (extra.mediaOptions as Record<string, unknown>).container === 'compactMKV' ? 'compactMKV' : 'compatibleMP4',
              subtitleLanguage: typeof (extra.mediaOptions as Record<string, unknown>).subtitleLanguage === 'string'
                ? String((extra.mediaOptions as Record<string, unknown>).subtitleLanguage) : null
            }
          : null
      }
    : {
        operation, url: String(extra.url ?? '').trim(), filename: text('filename'), folderPath: text('folderPath'),
        formatID: String(extra.formatID ?? 'best'),
        container: extra.container === 'compactMKV' ? 'compactMKV' : 'compatibleMP4',
        subtitleLanguage: text('subtitleLanguage')
      }
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex')
}

export function decodeCreationReceipts(value: unknown): Map<string, WindowsCreationReceipt> {
  if (value === undefined) return new Map()
  if (!value || typeof value !== 'object') throw new Error('添加记录无法读取')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.entries)) throw new Error('添加记录版本无法读取')
  const receipts = new Map<string, WindowsCreationReceipt>()
  for (const item of record.entries) {
    if (!item || typeof item !== 'object') throw new Error('添加记录无法读取')
    const receipt = item as WindowsCreationReceipt
    const creationKey = normalizeCreationKey(receipt.creationKey)
    if (typeof receipt.intentDigest !== 'string' || !/^[\da-f]{64}$/.test(receipt.intentDigest)
        || !Number.isSafeInteger(receipt.taskID) || receipt.taskID < 1 || receipts.has(creationKey)) {
      throw new Error('添加记录无法读取')
    }
    receipts.set(creationKey, { creationKey, intentDigest: receipt.intentDigest, taskID: receipt.taskID })
  }
  return receipts
}

/** Replace only after the complete task + receipt snapshot has reached disk. */
export async function writeAtomicWindowsState(path: string, payload: string): Promise<void> {
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(payload, 'utf8')
    await file.sync()
    await file.close()
    await rename(temporary, path)
  } finally {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}
