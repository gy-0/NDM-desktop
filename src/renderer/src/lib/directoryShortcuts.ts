import { isDirectoryForPlatform } from '../../../shared/directoryRules'

export type DirectoryShortcuts = { version: 1; favorites: string[]; recent: string[] }
const KEY = 'ndm.directory-shortcuts.v1'
const EVENT = 'ndm:directory-shortcuts'
const empty = (): DirectoryShortcuts => ({ version: 1, favorites: [], recent: [] })
const valid = (path: unknown): path is string => typeof path === 'string' && path.length <= 4096
  && (isDirectoryForPlatform(path, 'posix') || isDirectoryForPlatform(path, 'win32'))

export function decodeDirectoryShortcuts(raw: string | null): DirectoryShortcuts {
  if (!raw || raw.length > 160 * 1024) return empty()
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !Array.isArray(value.favorites) || !Array.isArray(value.recent)) return empty()
    return { version: 1, favorites: [...new Set<string>(value.favorites.filter(valid))].slice(0, 16),
      recent: [...new Set<string>(value.recent.filter(valid))].slice(0, 20) }
  } catch { return empty() }
}

export function updateDirectoryShortcuts(state: DirectoryShortcuts, path: string, action: 'remember' | 'favorite'): DirectoryShortcuts {
  if (!valid(path)) return state
  return action === 'remember'
    ? { ...state, recent: [path, ...state.recent.filter(value => value !== path)].slice(0, 20) }
    : { ...state, favorites: state.favorites.includes(path) ? state.favorites.filter(value => value !== path)
      : [path, ...state.favorites].slice(0, 16) }
}

export function readDirectoryShortcuts(): DirectoryShortcuts {
  try { return decodeDirectoryShortcuts(localStorage.getItem(KEY)) } catch { return empty() }
}
export function saveDirectoryShortcut(path: string, action: 'remember' | 'favorite' = 'remember'): void {
  const next = updateDirectoryShortcuts(readDirectoryShortcuts(), path, action)
  try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(EVENT)) } catch { /* A shortcut must never block choosing a destination. */ }
}
export function subscribeDirectoryShortcuts(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener('storage', onChange) }
}

/** An automatically shown folder must not override the engine's rules. */
export function explicitComposerDirectory(edited: boolean, path: string): string | undefined {
  return edited && path.trim() ? path.trim() : undefined
}
