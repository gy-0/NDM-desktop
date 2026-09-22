import { useEffect, useRef, type ComponentProps } from 'react'
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
  const button = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (busy) return
    if (restoreFocus.current && !disabled && document.activeElement === document.body) {
      button.current?.focus({ preventScroll: true })
    }
    restoreFocus.current = false
  }, [busy, disabled, checked])
  const handleClick = (): void => {
    if (busy) return
    restoreFocus.current = document.activeElement === button.current
    onCheckedChange(!checked)
  }

  return (
    <button
      ref={button}
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
