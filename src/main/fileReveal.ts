import { dirname, isAbsolute } from 'node:path'

export type FileRevealResult = boolean | 'parent-opened'
interface RevealDependencies {
  exists: (path: string) => boolean
  installedPath: (path: string) => Promise<string | null>
  showItem: (path: string) => void
  openPath: (path: string) => Promise<string>
}

/** Opening a surviving parent directory is useful, but is not finding the file. */
export async function revealDownloadedFile(path: unknown, dependencies: RevealDependencies): Promise<FileRevealResult> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return false
  try {
    if (dependencies.exists(path)) { dependencies.showItem(path); return true }
    const installed = await dependencies.installedPath(path)
    if (installed && dependencies.exists(installed)) { dependencies.showItem(installed); return true }
    const parent = dirname(path)
    if (dependencies.exists(parent) && !await dependencies.openPath(parent)) return 'parent-opened'
    return false
  } catch { return false }
}
