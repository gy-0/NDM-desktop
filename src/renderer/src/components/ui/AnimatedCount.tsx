import { cn } from '../../lib/cn'

const plainNumber = (value: number): string => String(value)

/** One visible number at every frame. The containing live region announces it. */
export function AnimatedCount({ value, className, formatValue = plainNumber }: {
  value: number
  className?: string
  formatValue?: (value: number) => string
}) {
  return (
    <span data-animated-count data-count-value={value} className={cn('relative inline-grid shrink-0 whitespace-nowrap text-right tabular-nums align-baseline', className)}>
      <span data-count-current aria-hidden="true">{formatValue(value)}</span>
      <span className="sr-only">{formatValue(value)}</span>
    </span>
  )
}
