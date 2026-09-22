import { useEffect, useRef, useState } from 'react'
import { browserLabel, type SessionBrowserID } from '../../../shared/browserSessions'
import { browserPageMediaError, readBrowserPageMediaSources, ambiguousBrowserPageMediaSources, type BrowserPageMediaChoice, type BrowserPageMediaItem, type BrowserPageMediaSource } from '../../../shared/browserPageMedia'
import { LoadingMark } from './LoadingMark'

export function BrowserPageMediaPicker({ pageURL, disabled, choice, onSelect, autoRead = false }: {
  autoRead?: boolean
  pageURL: string; disabled: boolean; choice: BrowserPageMediaChoice | null
  onSelect: (choice: BrowserPageMediaChoice | null, item?: BrowserPageMediaItem, pageTitle?: string) => void
}) {
  const [sources, setSources] = useState<BrowserPageMediaSource[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  useEffect(() => {
    ++sequence.current; setSources([]); setBusy(false); setError(null)
    if (autoRead) void read()
    return () => { ++sequence.current }
  }, [pageURL])
  const read = async (): Promise<void> => {
    if (disabled || busy) return
    const seq = ++sequence.current
    setBusy(true); setError(null); setSources([]); onSelect(null)
    try {
      const reply = await window.ndm?.request('probeBrowserPageMedia', { pageURL })
      const found = readBrowserPageMediaSources(reply, pageURL)
      if (seq !== sequence.current) return
      if (ambiguousBrowserPageMediaSources(found)) {
        setError('发现多个相同页面，无法区分浏览器个人资料。请到要使用的浏览器页面点击 NDM 下载，或仅保留一个目标页面为当前标签后重新读取。')
        return
      }
      setSources(found)
      if (!found.length) setError('未找到当前页面的视频版本。请在原浏览器打开此视频并播放，再读取页面。')
    } catch (error) { if (seq === sequence.current) setError(browserPageMediaError(error)) }
    finally { if (seq === sequence.current) setBusy(false) }
  }
  return <section className="mt-3 rounded-xl border border-line/70 bg-ink/20 p-3" aria-label="浏览器页面视频">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled || busy} onClick={() => void read()} className="h-8 rounded-control bg-copper px-3 text-[12px] font-medium text-on-accent disabled:opacity-50">从浏览器页面读取</button>
      <button type="button" disabled={disabled} onClick={() => void window.ndm?.openExternal(pageURL)} className="h-8 rounded-control border border-line px-3 text-[12px] text-fog disabled:opacity-50">在浏览器中打开</button>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-mist">请在原浏览器的当前标签页打开并播放此视频。只读取该页面已捕获的版本，再由你选择下载。</p>
    {busy ? <div className="mt-2"><LoadingMark label="正在读取浏览器页面…" /></div> : null}
    {error ? <p role="status" className="mt-2 text-[12px] text-clay">{error}</p> : null}
    {sources.map((source, index) => <fieldset key={source.sourceToken} disabled={disabled || busy} className="mt-3 min-w-0 border-t border-line/70 pt-2">
      <legend className="max-w-full truncate pr-2 text-[12px] text-paper">{browserLabel(source.browser as SessionBrowserID) || source.browser} · 页面 {index + 1}{source.incognito ? ' · 隐身窗口' : ''} · {source.title || '视频页面'}</legend>
      <div className="mt-1 grid gap-1.5">
        {source.items.map(item => {
          const selected = choice?.sourceToken === source.sourceToken && choice.mediaKey === item.mediaKey && choice.pageURL === pageURL
          return <button key={item.mediaKey} type="button" aria-pressed={selected}
            onClick={() => onSelect({ sourceToken: source.sourceToken, mediaKey: item.mediaKey, pageURL }, item, source.title)}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[12px] transition-colors disabled:opacity-50 ${selected ? 'border-copper bg-copper/10 text-paper' : 'border-line text-fog hover:bg-line/40'}`}>
            <span className="min-w-0 truncate">{item.title || '视频'}{item.meta ? ` · ${item.meta}` : ''}</span>
            <span className="shrink-0 text-copper">{selected ? '已选择' : item.badge || (item.quality !== '0' ? `${item.quality}p` : '选择版本')}</span>
          </button>
        })}
      </div>
    </fieldset>)}
  </section>
}
