import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export type SegmentedOption<T extends string | number> = {
  value: T
  label: ReactNode
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  fit = 'equal',
  className,
  'aria-label': ariaLabel,
  'aria-busy': ariaBusy,
  'aria-describedby': ariaDescribedBy
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  fit?: 'equal' | 'hug'
  className?: string
  'aria-label'?: string
  'aria-busy'?: boolean
  'aria-describedby'?: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => {
      const button = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      if (!button) { setSelection(null); return }
      // Offset coordinates belong to this track, so ancestor scroll/layout
      // changes never create a page-space projection animation.
      const next = { left: button.offsetLeft, top: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight }
      setSelection(current => current && current.left === next.left && current.top === next.top
        && current.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.querySelectorAll('button').forEach(button => observer.observe(button))
    return () => observer.disconnect()
  }, [value, options, fit])

  return (
      <div
        ref={track}
        role="group"
        aria-label={ariaLabel}
        aria-busy={ariaBusy}
        aria-describedby={ariaDescribedBy}
        className={cn(
          'ndm-segmented relative isolate rounded-[8px] border border-line/75 bg-panel/45 p-0.5',
          fit === 'equal' ? 'grid' : 'inline-flex',
          className
        )}
        style={fit === 'equal' ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
      >
        {selection && <span
          aria-hidden="true"
          className="ndm-segmented-selection pointer-events-none absolute -z-10 rounded-[6px] transition-[left,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none bg-raised shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_24%,var(--line)),0_1px_2px_rgb(0_0_0/0.08)]"
          style={selection}
        />}
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={String(option.value)}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              data-cuelume-press="tick"
              onClick={() => onChange(option.value)}
              className={cn(
                'relative isolate inline-flex h-7 min-w-0 items-center justify-center rounded-[6px] px-2 text-[12.5px] leading-none transition-[color,background-color,scale] duration-150 active:scale-[0.96] disabled:opacity-55',
                fit === 'hug' ? 'whitespace-nowrap px-2.5' : '',
                active ? 'font-medium text-paper' : 'text-mist hover:text-paper'
              )}
            >
              <span className="relative z-[1] inline-flex items-center justify-center text-[12.5px] leading-none">{option.label}</span>
            </button>
          )
        })}
      </div>
  )
}
