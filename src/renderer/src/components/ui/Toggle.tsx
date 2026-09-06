import { useState, type ComponentProps } from 'react'
import { clsx } from 'clsx'

/**
 * Accessible switch with the t-toggle thumb animation (transitions.dev 27).
 * `.is-init` (set on the first interaction) gates the double-bounce keyframes
 * so a switch doesn't play its return bounce on mount. Track colour uses the
 * `--toggle-track` token instead of an inline background, keeping the
 * cross-fade on its own rhythm rather than the Tailwind duration-200 override.
 */
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
  const [isInit, setIsInit] = useState(false)

  const handleClick = (): void => {
    setIsInit(true)
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
      disabled={disabled}
      {...rest}
      onClick={handleClick}
      className={clsx(
        't-toggle relative h-[20px] w-[36px] rounded-full disabled:cursor-wait disabled:opacity-55 transition-colors',
        busy && 'cursor-wait opacity-55',
        isInit && 'is-init',
        className
      )}
    >
      <span className="t-toggle-thumb absolute left-[2px] top-[2px] size-[16px] rounded-full bg-raised" />
    </button>
  )
}