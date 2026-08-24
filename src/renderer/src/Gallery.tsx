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
    <div className="flex h-full flex-col bg-ink text-paper">
      <header className="app-drag flex h-[64px] shrink-0 items-end justify-between border-b border-line px-6 pb-3">
        <div>
          <div className="text-[18px] font-semibold leading-none">外观预览</div>
          <div className="mt-1 text-[11px] text-mist">比较完整窗口，不改变当前设置</div>
        </div>
        <div className="app-no-drag text-[12px] text-mist">选择“打开”查看可交互版本</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 scroll-quiet">
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((theme) => (
            <article key={theme.id} className="overflow-hidden rounded-lg border border-line bg-panel">
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
