import { useState, type ReactNode } from 'react'
import { setSoundEnabled, soundEnabled } from '../lib/sound'
import { THEMES, type ThemeId } from '../lib/themes'

export function Settings({
  open,
  themeId,
  onTheme,
  onClose
}: {
  open: boolean
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
  onClose: () => void
}) {
  const [sound, setSound] = useState(soundEnabled)
  if (!open) return null

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-ink/40" onClick={onClose}>
      <aside
        className="flex h-full w-[360px] flex-col border-l border-line bg-panel"
        style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-drag flex h-[52px] items-center justify-between px-5">
          <div className="text-[13px] font-medium">设置</div>
          <button type="button" className="app-no-drag text-[12px] text-mist" onClick={onClose} data-cuelume-press="droplet">
            完成
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-8 scroll-quiet">
          <Section title="外观">
            <p className="mb-3 text-[12px] leading-relaxed text-mist">深色用胡桃夜，浅色用胡桃昼。想更素一点，选白昼。</p>
            <div className="grid gap-2">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-cuelume-toggle
                  onClick={() => onTheme(theme.id)}
                  className={`flex items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-[transform,background-color] duration-150 active:scale-[0.98] ${
                    theme.id === themeId ? 'border-line-strong bg-raised' : 'border-line'
                  }`}
                >
                  <Swatch id={theme.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{theme.name}</span>
                    <span className="block text-[12px] text-mist">{theme.line}</span>
                  </span>
                </button>
              ))}
            </div>
          </Section>
          <Section title="声音">
            <label className="flex items-center justify-between rounded-[12px] border border-line px-3 py-2.5">
              <span>
                <span className="block text-[13px] font-medium">操作提示音</span>
                <span className="block text-[12px] text-mist">点击和完成时发出轻声提示</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={sound}
                data-cuelume-toggle
                onClick={() => {
                  const next = !sound
                  setSound(next)
                  setSoundEnabled(next)
                }}
                className="relative h-[22px] w-[38px] rounded-full transition-colors duration-200"
                style={{ background: sound ? 'var(--accent)' : 'var(--line-strong)' }}
              >
                <span
                  className="absolute top-[2px] left-[2px] size-[18px] rounded-full bg-raised transition-transform duration-200"
                  style={{
                    transform: sound ? 'translateX(16px)' : 'translateX(0)',
                    transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)'
                  }}
                />
              </button>
            </label>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-mist">{title}</div>
      {children}
    </section>
  )
}

function Swatch({ id }: { id: ThemeId }) {
  const fill = id === 'walnut' ? '#141210' : id === 'dawn' ? '#f4efe6' : '#f5f4f0'
  const mark = id === 'noon' ? '#2a4a7a' : '#d08a3a'
  return (
    <span className="relative h-10 w-10 overflow-hidden rounded-[10px] border border-line" style={{ background: fill }}>
      <span className="absolute inset-x-1 bottom-1 h-1 rounded-full" style={{ background: mark }} />
    </span>
  )
}
