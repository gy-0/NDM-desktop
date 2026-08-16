import { type ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/cn'

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<'div'> {
  /** Animation speed multiplier; higher is faster. */
  speed?: number
  /** The color the text sweeps through at the leading edge. */
  colorFrom?: string
  /** The color the text sweeps through at the trailing edge. */
  colorTo?: string
}

/**
 * Text with a copper shimmer that travels across it — a recolor of magicui's
 * AnimatedGradientText. Use it for an eyebrow, a badge, or a single hero word.
 */
export function AnimatedShinyText({
  children,
  className,
  speed = 1,
  colorFrom = '#b86e36',
  colorTo = '#f7efe2',
  ...props
}: AnimatedShinyTextProps) {
  return (
    <span
      style={
        {
          '--bg-size': `${speed * 300}%`,
          '--color-from': colorFrom,
          '--color-to': colorTo
        } as React.CSSProperties
      }
      className={cn(
        'animate-gradient inline bg-linear-to-r from-(--color-from) via-(--color-to) to-(--color-from) bg-size-[var(--bg-size)_100%] bg-clip-text text-transparent',
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}
