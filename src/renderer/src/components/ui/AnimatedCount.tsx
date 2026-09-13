import { useLayoutEffect, useRef } from 'react'
import { animate } from 'motion/react'
import { cn } from '../../lib/cn'
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference'

const plainNumber = (value: number): string => String(value)

/** Controlled count feedback. The surrounding live region owns announcements. */
export function AnimatedCount({ value, className, formatValue = plainNumber }: {
  value: number
  className?: string
  formatValue?: (value: number) => string
}) {
  const reducedMotion = useReducedMotionPreference()
  const lastValue = useRef(value)
  const currentRef = useRef<HTMLSpanElement>(null)
  const outgoingRef = useRef<HTMLSpanElement>(null)
  const formatRef = useRef(formatValue)
  formatRef.current = formatValue

  useLayoutEffect(() => {
    const current = currentRef.current
    const outgoing = outgoingRef.current
    if (!current || !outgoing) return
    const previousValue = lastValue.current
    lastValue.current = value
    // This slot is owned by the effect, so unrelated React renders cannot
    // replace its text halfway through an outgoing transition.
    outgoing.textContent = formatRef.current(previousValue)
    const finish = () => {
      current.style.opacity = '1'
      current.style.transform = 'none'
      outgoing.style.opacity = '0'
      outgoing.style.transform = 'none'
    }
    if (reducedMotion || previousValue === value) {
      finish()
      return
    }
    const tokens = getComputedStyle(document.documentElement)
    // CSS minification can rewrite 150ms as .15s; preserve the token's unit.
    const durationToken = tokens.getPropertyValue('--duration-quick').trim()
    const durationValue = Number.parseFloat(durationToken)
    const duration = Number.isFinite(durationValue)
      ? durationValue / (durationToken.endsWith('ms') ? 1000 : 1)
      : .15
    const distance = Number.parseFloat(tokens.getPropertyValue('--distance-micro')) || 4
    const direction = value > previousValue ? 1 : -1
    const paint = (phase: number) => {
      if (phase >= 1) { finish(); return }
      current.style.opacity = String(phase)
      current.style.transform = `translateY(${(1 - phase) * direction * distance}px)`
      outgoing.style.opacity = String(1 - phase)
      outgoing.style.transform = `translateY(${-phase * direction * distance}px)`
    }
    // Set the first frame synchronously; Motion owns only the scalar clock.
    // There is no render-phase state update or derived-value subscription chain.
    paint(0)
    const playback = animate(0, 1, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: paint
    })
    return () => playback.stop()
  }, [value, reducedMotion])

  return (
    <span data-animated-count className={cn('relative inline-grid shrink-0 overflow-hidden whitespace-nowrap text-right tabular-nums align-baseline', className)}>
      {/* Two stable slots bound work during rapid updates. Both contribute to
          width, so the larger number is never clipped while digits change. */}
      <span ref={outgoingRef} aria-hidden="true" data-count-outgoing className="col-start-1 row-start-1"
        style={{ opacity: 0 }} />
      <span ref={currentRef} aria-hidden="true" data-count-current className="col-start-1 row-start-1"
        style={{ opacity: 1 }}>
        {formatValue(value)}
      </span>
      <span className="sr-only">{formatValue(value)}</span>
    </span>
  )
}
