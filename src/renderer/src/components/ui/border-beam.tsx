import { motion, type MotionStyle, type Transition } from 'motion/react'
import { cn } from '@/lib/cn'

interface BorderBeamProps {
  /** The size of the border beam, in pixels. */
  size?: number
  /** The duration of one full circuit, in seconds. */
  duration?: number
  /** A negative delay so the beam starts partway around the frame. */
  delay?: number
  /** The color the beam fades in from (toward the leading edge). */
  colorFrom?: string
  /** The color the beam fades out to (trailing edge). */
  colorTo?: string
  /** The motion transition of the border beam. */
  transition?: Transition
  /** Extra classes for the moving highlight itself. */
  className?: string
  /** Extra styles for the moving highlight itself. */
  style?: React.CSSProperties
  /** Whether to reverse the animation direction. */
  reverse?: boolean
  /** The initial offset position (0-100) around the frame. */
  initialOffset?: number
  /** The thickness of the beam's trail, in pixels. */
  borderWidth?: number
}

/**
 * A travelling highlight that sweeps the border of its positioned parent — a
 * copper recolor of magicui's BorderBeam. Drop it inside any
 * `relative`/`absolute inset-0 rounded-[inherit]` frame.
 */
export function BorderBeam({
  className,
  size = 50,
  delay = 0,
  duration = 6,
  colorFrom = '#d79343',
  colorTo = '#f7efe2',
  transition,
  style,
  reverse = false,
  initialOffset = 0,
  borderWidth = 1.5
}: BorderBeamProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)] mask-intersect [mask-clip:padding-box,border-box]"
      style={{ '--border-beam-width': `${borderWidth}px` } as React.CSSProperties}
    >
      <motion.div
        className={cn(
          'absolute aspect-square',
          'bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent',
          className
        )}
        style={
          {
            width: size,
            offsetPath: `rect(0 auto auto 0 round ${size}px)`,
            '--color-from': colorFrom,
            '--color-to': colorTo,
            ...style
          } as MotionStyle
        }
        initial={{ offsetDistance: `${initialOffset}%` }}
        animate={{
          offsetDistance: reverse
            ? [`${100 - initialOffset}%`, `${-initialOffset}%`]
            : [`${initialOffset}%`, `${100 + initialOffset}%`]
        }}
        transition={{
          repeat: Infinity,
          ease: 'linear',
          duration,
          delay: -delay,
          ...transition
        }}
      />
    </div>
  )
}
