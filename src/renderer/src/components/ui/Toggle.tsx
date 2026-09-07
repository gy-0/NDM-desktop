import { type ComponentProps } from 'react'
import { clsx } from 'clsx'

/** Interruptible thumb travel; acknowledged state and pending feedback stay distinct. */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  busy = false,
  className,
  ...rest
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label: string
  disabled?: boolean
  busy?: boolean
  className?: string
} & Pick<ComponentProps<'button'>, 'aria-describedby'>) {
  const handleClick = (): void => {
    if (busy) return
    onCheckedChange(!checked)
  }

  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy}
      data-cuelume-toggle
      data-on={checked ? 'true' : 'false'}
      disabled={disabled || busy}
      {...rest}
      onClick={handleClick}
      className={clsx(
        't-toggle relative h-[20px] w-[36px] rounded-full disabled:cursor-wait disabled:opacity-55 transition-colors',
        busy && 'cursor-wait opacity-55',
        className
      )}
    >
      <span className="t-toggle-thumb absolute left-[2px] top-[2px] size-[16px] rounded-full bg-raised" />
    </button>
  )
}