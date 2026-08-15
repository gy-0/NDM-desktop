import { THEMES } from './lib/themes'

export function Gallery() {
  const previewUrl = (themeId: string): string => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('theme', themeId)
    url.searchParams.set('embed', '1')
    return url.href
  }

  return (
    <div className="flex h-full flex-col bg-[#111110] text-[#efe8dc]">
      <header className="app-drag flex h-[52px] shrink-0 items-end justify-between px-6 pb-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">外观</div>
          <div className="font-serif text-[22px] leading-none">选一套外观</div>
        </div>
        <div className="app-no-drag text-[12px] text-white/40">点打开，在窗口里预览</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 scroll-quiet">
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((theme) => (
            <article key={theme.id} className="overflow-hidden rounded-xl border border-white/10 bg-[#191816]">
              <div className="flex items-center justify-between px-3 py-2.5">
                <div>
                  <div className="text-[15px]">{theme.name}</div>
                  <div className="text-[11px] text-white/40">{theme.line}</div>
                </div>
                <button
                  type="button"
                  className="app-no-drag rounded-full bg-[#efe8dc] px-3 py-1 text-[12px] text-[#191816]"
                  onClick={() => window.ndm?.openTheme?.(theme.id) ?? (location.search = `?theme=${theme.id}`)}
                >
                  打开
                </button>
              </div>
              <div className="relative h-[220px] overflow-hidden border-t border-white/8 bg-black">
                <iframe
                  title={theme.name}
                  src={previewUrl(theme.id)}
                  className="pointer-events-none origin-top-left border-0"
                  style={{ width: 1220, height: 780, transform: 'scale(0.36)' }}
                />
              </div>
              <p className="px-3 py-2.5 text-[11px] leading-relaxed text-white/50">{theme.note}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
