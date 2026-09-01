import { LayoutGroup, motion } from 'motion/react'
import { useId, type ReactNode } from 'react'
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
  const layoutId = useId()

  return (
    <LayoutGroup id={layoutId}>
      <div
        role="group"
        aria-label={ariaLabel}
        aria-busy={ariaBusy}
        aria-describedby={ariaDescribedBy}
        className={cn(
          'relative rounded-[9px] border border-line bg-panel/60 p-[3px]',
          fit === 'equal' ? 'grid' : 'inline-flex',
          className
        )}
        style={fit === 'equal' ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
      >
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
                'relative isolate min-w-0 rounded-[7px] px-2 py-1 text-[12.5px] transition-[color,background-color,scale] duration-150 active:scale-[0.97] disabled:opacity-55',
                fit === 'hug' ? 'whitespace-nowrap px-2.5' : 'h-[26px]',
                active ? 'font-medium text-paper' : 'text-mist hover:text-paper'
              )}
            >
              {[
                active ? (
                  <motion.span
                    key="indicator"
                    layoutId="indicator"
                    className="absolute inset-0 -z-10 rounded-[7px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_24%,var(--line)),0_1px_2px_rgb(0_0_0/0.08)]"
                    initial={false}
                    transition={{ type: 'tween', duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  />
                ) : null,
                <span key="label" className="relative z-[1] inline-flex h-full items-center justify-center text-[12.5px]">{option.label}</span>
              ]}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
