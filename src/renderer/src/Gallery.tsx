import { useEffect, useState } from 'react'
import { THEMES } from './lib/themes'
import { Toggle } from './components/ui/Toggle'

export function Gallery() {
  const [teakPreview, setTeakPreview] = useState(false)

  const previewUrl = (themeId: string): string => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('theme', themeId)
    url.searchParams.set('embed', '1')
    return url.href
  }

  // The preview card's accent lives on the card element; the embedded window
  // preview lives in a same-origin iframe whose documentElement gets the same
  // attribute, so the teak override block in index.css can reach both.
  useEffect(() => {
    if (!teakPreview) return
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('article iframe'))
    for (const frame of frames) {
      frame.contentDocument?.documentElement.setAttribute('data-gallery-preview', 'teak')
    }
    return () => {
      for (const frame of frames) {
        frame.contentDocument?.documentElement.removeAttribute('data-gallery-preview')
      }
    }
  }, [teakPreview])

  return (
    <div className="flex h-full flex-col bg-ink text-paper">
      <header className="app-drag flex h-[64px] shrink-0 items-end justify-between border-b border-line px-6 pb-3">
        <div>
          <div className="text-[18px] font-semibold leading-none">外观预览</div>
          <div className="mt-1 text-[11px] text-mist">比较完整窗口，不改变当前设置</div>
        </div>
        <div className="app-no-drag flex items-center justify-between gap-4">
          <div className="text-right">
            <span className="block text-[13px] font-medium text-paper">暖铜 accent 预览</span>
            <span className="block text-[12px] text-mist">仅预览候选色，不改变当前设置</span>
          </div>
          <Toggle
            checked={teakPreview}
            onCheckedChange={setTeakPreview}
            label="暖铜 accent 预览"
            className="shrink-0"
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 scroll-quiet">
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((theme) => (
            <article
              key={theme.id}
              className="overflow-hidden rounded-lg border border-line bg-panel"
              data-preview-theme={theme.id}
              data-gallery-preview={teakPreview ? 'teak' : 'default'}
            >
              <div className="flex items-center justify-between px-3 py-2.5">
                <div>
                  <div className="text-[15px]">{theme.name}</div>
                  <div className="text-[11px] text-mist">{theme.line}</div>
                </div>
                <button
                  type="button"
                  className="app-no-drag rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-on-accent transition-colors hover:bg-paper"
                  onClick={() => window.ndm?.openTheme?.(theme.id) ?? (location.search = `?theme=${theme.id}`)}
                >
                  打开
                </button>
              </div>
              <div className="relative h-[220px] overflow-hidden border-y border-line bg-ink">
                <iframe
                  title={theme.name}
                  src={previewUrl(theme.id)}
                  className="pointer-events-none origin-top-left border-0"
                  style={{ width: 1220, height: 780, transform: 'scale(0.36)' }}
                />
              </div>
              <p className="px-3 py-2.5 text-[11px] leading-relaxed text-mist">{theme.note}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
