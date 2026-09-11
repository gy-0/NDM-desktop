import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

/** Native drags contain existing files only, never a URL or partial download. */
export function existingDragFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return []
  const files = [...new Set(value)]
  for (const file of files) {
    if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) return []
    try { if (!statSync(file).isFile()) return [] } catch { return [] }
  }
  return files as string[]
}
