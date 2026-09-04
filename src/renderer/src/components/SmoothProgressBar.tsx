import { useEffect, useRef } from 'react'
import { advanceProgressMotion, createProgressMotion } from '../effects/metalforge/progressMotion'

const MOTION_EPSILON = 0.0005
const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/**
 * A lightweight compositor-only progress track for virtualized task rows.
 * Engine snapshots only retarget the motion; React never renders every frame.
 */
export function SmoothProgressBar({
  fraction,
  active,
  fillClassName
}: {
  fraction: number
  active: boolean
  fillClassName: string
}) {
  const target = clamp01(fraction)
  const targetRef = useRef(target)
  targetRef.current = target
  const motionRef = useRef(createProgressMotion(target))
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const paint = (value: number): void => {
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${clamp01(value)})`
  }

  const scheduleFrame = (): void => {
    if (reducedMotion || frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame((nowMs) => {
      frameRef.current = null
      const nextTarget = targetRef.current
      advanceProgressMotion(motionRef.current, nowMs, nextTarget)
      paint(Math.min(motionRef.current.progress, nextTarget))
      if (active && Math.abs(motionRef.current.progress - nextTarget) > MOTION_EPSILON) scheduleFrame()
    })
  }

  useEffect(() => {
    if (reducedMotion || !active) {
      motionRef.current = createProgressMotion(target)
      paint(target)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      return
    }
    scheduleFrame()
    // The scalar target wakes one persistent compositor loop without making
    // React own the intermediate frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reducedMotion, target])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  return (
    <span
      role="progressbar"
      aria-label="任务下载进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(target * 100)}
      className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line/80"
    >
      <span
        ref={fillRef}
        data-row-progress-fill
        className={`block h-full w-full rounded-[2px] will-change-transform ${fillClassName}`}
        style={{ transform: `scaleX(${motionRef.current.progress})`, transformOrigin: 'left center' }}
      />
    </span>
  )
}
