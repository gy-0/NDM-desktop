import { cn } from '../lib/cn'

export function SquareChoice<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
  'aria-busy': ariaBusy,
  'aria-describedby': ariaDescribedBy
}: {
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  disabled?: boolean
  'aria-label'?: string
  'aria-busy'?: boolean
  'aria-describedby'?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      aria-describedby={ariaDescribedBy}
      className="flex shrink-0 items-center gap-1.5"
    >
      {options.map((option) => {
        const active = option === value
        return (
          <button
            key={String(option)}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            data-cuelume-press="tick"
            onClick={() => onChange(option)}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-[8px] transition-[color,background-color,box-shadow,scale] duration-150 active:scale-[0.96] disabled:opacity-55',
              active
                ? 'bg-raised font-medium text-copper shadow-[0_0_0_1px_var(--line-strong)]'
                : 'text-mist shadow-[0_0_0_1px_var(--line)] hover:text-paper hover:shadow-[0_0_0_1px_var(--line-strong)]'
            )}
          >
            <span className="font-mono text-[12.5px] tabular-nums">{option}</span>
          </button>
        )
      })}
    </div>
  )
}
