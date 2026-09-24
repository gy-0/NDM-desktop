import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { isDirectoryForPlatform } from '../../../shared/directoryRules'
import { readDirectoryShortcuts, saveDirectoryShortcut, subscribeDirectoryShortcuts } from '../lib/directoryShortcuts'

export function DirectoryShortcuts({ currentDirectory, disabled, onChoose, onUseDefault }: {
  currentDirectory: string; disabled?: boolean; onChoose(path: string): void; onUseDefault?(): void
}) {
  const [state, setState] = useState(readDirectoryShortcuts)
  useEffect(() => subscribeDirectoryShortcuts(() => setState(readDirectoryShortcuts())), [])
  const platform = window.ndm?.platform === 'win32' ? 'win32' : 'posix'
  const favorites = state.favorites.filter(path => isDirectoryForPlatform(path, platform))
  const recent = state.recent.filter(path => isDirectoryForPlatform(path, platform) && !favorites.includes(path))
  const row = (path: string) => <li key={path} className="flex min-w-0 items-center gap-1">
    <button type="button" disabled={disabled} title={path} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-meta text-fog hover:bg-line disabled:opacity-40" onClick={() => { saveDirectoryShortcut(path); onChoose(path) }}>{path}</button>
    <button type="button" disabled={disabled} aria-label={`${favorites.includes(path) ? '取消收藏' : '收藏目录'} ${path}`} className="rounded p-1.5 text-mist hover:text-copper disabled:opacity-40" onClick={() => saveDirectoryShortcut(path, 'favorite')}><Star size={12} className={favorites.includes(path) ? 'fill-copper text-copper' : ''} /></button>
  </li>
  return <div className="flex flex-wrap items-start gap-3 text-meta">
    {onUseDefault ? <button type="button" disabled={disabled} className="py-1 text-copper disabled:opacity-40" onClick={onUseDefault}>恢复自动选择目录</button> : null}
    {currentDirectory && isDirectoryForPlatform(currentDirectory, platform) ? <button type="button" disabled={disabled} className="inline-flex items-center gap-1 py-1 text-mist hover:text-copper disabled:opacity-40" onClick={() => saveDirectoryShortcut(currentDirectory, 'favorite')}><Star size={12} className={favorites.includes(currentDirectory) ? 'fill-copper text-copper' : ''} />{favorites.includes(currentDirectory) ? '取消收藏当前目录' : '收藏当前目录'}</button> : null}
    {favorites.length || recent.length ? <details className="min-w-0 flex-1 rounded-control border border-line px-2 py-1"><summary className="cursor-pointer text-mist">收藏与最近目录</summary>
      <div className="mt-2 max-h-48 overflow-auto">{favorites.length ? <><p className="px-2 text-caption text-mist">收藏</p><ul>{favorites.map(row)}</ul></> : null}{recent.length ? <><p className="mt-2 px-2 text-caption text-mist">最近使用</p><ul>{recent.map(row)}</ul></> : null}</div>
    </details> : null}
  </div>
}
