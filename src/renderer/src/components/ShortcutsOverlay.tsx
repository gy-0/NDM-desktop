import { useEffect, useRef, useState } from 'react'
import { Command, X } from 'lucide-react'
import { cue } from '../lib/sound'

// Keep the close timer in sync with the --modal-close-dur token in index.css.
function modalCloseMs(): number {
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')
  )
  return Number.isFinite(value) ? value : 150
}

type Shortcut = { keys: string[]; label: string }

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '全局',
    items: [
      { keys: ['⌘', 'N'], label: '新建下载' },
      { keys: ['⌘', ','], label: '设置' },
      { keys: ['/'], label: '搜索任务' },
      { keys: ['?'], label: '快捷键速查（本页）' }
    ]
  },
  {
    title: '选中任务',
    items: [
      { keys: ['↑', '↓'], label: '移动选择 · Shift 扩选' },
      { keys: ['Space'], label: '快速预览（Quick Look）' },
      { keys: ['Enter'], label: '打开文件 / 暂停或继续' },
      { keys: ['⌘', 'C'], label: '复制下载链接' },
      { keys: ['⌘', 'R'], label: '在访达中显示' }
    ]
  },
  {
    title: '批量与清理',
    items: [
      { keys: ['⌘', 'A'], label: '全选可见任务' },
      { keys: ['Delete'], label: '移出列表' },
      { keys: ['⌘', '⌫'], label: '移出并删除文件' },
      { keys: ['Esc'], label: '取消选择 / 关闭浮层' }
    ]
  }
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="grid min-w-[22px] place-items-center rounded-[6px] border border-line-strong bg-panel px-1.5 py-0.5 font-mono text-[11px] text-paper shadow-[0_1px_0_rgb(0_0_0/0.25)]">
      {children}
    </kbd>
  )
}

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [closing, setClosing] = useState(false)
  const closingTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (closingTimer.current !== null) window.clearTimeout(closingTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  function handleClose(): void {
    setClosing(true)
    if (closingTimer.current !== null) window.clearTimeout(closingTimer.current)
    closingTimer.current = window.setTimeout(() => {
      setClosing(false)
      onClose()
    }, modalCloseMs())
    cue('release')
  }

  return (
    <div
      className={`t-modal-scrim absolute inset-0 z-40 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px] ${closing ? 'is-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        className={`t-modal relative max-h-full w-[min(520px,100%)] overflow-y-auto rounded-[20px] border border-line-strong bg-raised/98 shadow-[0_28px_80px_rgb(0_0_0/0.45)] backdrop-blur-md scroll-quiet ${closing ? 'is-closing' : 'is-open'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[120px] rounded-t-[20px]"
          style={{
            background:
              'radial-gradient(90% 120% at 82% -20%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 62%)'
          }}
        />
        <div className="relative flex items-start justify-between px-6 pt-6">
          <h2 className="flex items-center gap-2 font-serif text-[24px] leading-tight tracking-[-0.01em] text-paper">
            <Command size={18} strokeWidth={1.7} className="translate-y-px text-copper" />
            键盘快捷键
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg p-1.5 text-mist transition-colors hover:bg-line hover:text-paper"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div className="relative grid gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-mist">{group.title}</div>
              <ul className="space-y-1.5">
                {group.items.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-3 text-[12px] text-fog">
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="relative border-t border-line/60 px-6 py-3 text-[11px] leading-relaxed text-mist">
          Windows 上 ⌘ 对应 Ctrl，⌫ 对应 Backspace。
        </div>
      </div>
    </div>
  )
}
