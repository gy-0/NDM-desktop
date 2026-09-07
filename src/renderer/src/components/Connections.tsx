import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { Segment } from '../lib/types'
import { useProgressEffects, type ProgressStyle } from '../lib/presentationPrefs'
import { placeSegments, type PlacedSegment } from '../lib/progressGeometry'
import { advanceProgressMotion, createProgressMotion, type ProgressMotion } from '../effects/metalforge/progressMotion'

import { paintSegmentMotions, type SegmentMotions } from '../effects/metalforge/segmentMotion'

const MOTION_EPSILON = 0.0005

type ProgressMode = 'continuous' | 'segmented'

type ProgressTarget = {
  fraction: number
  placed: PlacedSegment[]
  mode: ProgressMode
}

type ProgressMotions = {
  mode: ProgressMode
  continuous: ProgressMotion
  segments: SegmentMotions
}

/**
 * Exposed when the Hero-driven host loop owns the animation: the host advances
 * the shared motion, then calls `paint` so the total bar reads it while each segment keeps its own history.
 */
export type ConnectionsHandle = {
  paint: (shared: ProgressMotion, nowMs: number) => void
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

function createMotions(target: ProgressTarget): ProgressMotions {
  const segments: SegmentMotions = new Map()
  paintSegmentMotions(segments, target.placed, target.fraction, null)
  return {
    mode: target.mode,
    continuous: createProgressMotion(target.fraction),
    segments
  }
}

/** Keep the compositor's painted area bounded by the authoritative snapshot. */
function capVisualFills(
  placed: PlacedSegment[],
  fills: Map<number, number>,
  fileFraction: number
): Map<number, number> {
  const visiblePercent = placed.reduce(
    (sum, segment) => sum + Math.max(0, segment.width) * clamp01(fills.get(segment.id) ?? 0),
    0
  )
  const allowedPercent = clamp01(fileFraction) * 100
  if (visiblePercent <= allowedPercent || visiblePercent <= 0) return fills

  const scale = allowedPercent / visiblePercent
  const capped = new Map<number, number>()
  for (const segment of placed) capped.set(segment.id, clamp01((fills.get(segment.id) ?? 0) * scale))
  return capped
}

export function Connections({
  segments,
  active = false,
  fraction,
  fileSize = 0,
  style,
  sharedMotion = null,
  hostDriven = false,
  ref
}: {
  active?: boolean
  segments: Segment[]
  fraction: number
  fileSize?: number
  style: ProgressStyle
  /**
   * The shared ProgressMotion owned by the Hero. When present the segment bar
   * shares its frame clock; segment fills retain their independent history.
   */
  sharedMotion?: ProgressMotion | null
  /**
   * The Hero owns the single animation loop and drives this bar through the
   * imperative `paint` handle; the bar must not start a second rAF of its own.
   */
  hostDriven?: boolean
  ref?: Ref<ConnectionsHandle>
}) {
  const effects = useProgressEffects()
  const safeFraction = clamp01(fraction)
  const placed = placeSegments(segments, fileSize, safeFraction)
  const showSegments = style === 'segmented' && placed.length > 1
  const mode: ProgressMode = showSegments ? 'segmented' : 'continuous'
  const target: ProgressTarget = { fraction: safeFraction, placed, mode }
  const targetRef = useRef<ProgressTarget>(target)
  targetRef.current = target

  const motionsRef = useRef<ProgressMotions | null>(null)
  if (!motionsRef.current) {
    motionsRef.current = createMotions(target)
  } else if (motionsRef.current.mode !== mode) {
    // A presentation-mode change is a new visual track. Do not carry a scalar
    // bar into segment columns (or vice versa), which would make the switch
    // flash a stale fill before the next engine snapshot.
    motionsRef.current = createMotions(target)
  }

  const frameRef = useRef<number | null>(null)
  const continuousFillRef = useRef<HTMLDivElement | null>(null)
  const segmentFillRefs = useRef(new Map<number, HTMLDivElement>())
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  const activeRef = useRef(active)
  activeRef.current = active

  const sharedRef = useRef(sharedMotion)
  sharedRef.current = sharedMotion

  const paintContinuous = (progress: number): void => {
    if (continuousFillRef.current) {
      continuousFillRef.current.style.transform = `scaleX(${clamp01(progress)})`
    }
  }

  const paintSegments = (fills: Map<number, number>): void => {
    for (const [id, fill] of fills) {
      const node = segmentFillRefs.current.get(id)
      if (node) node.style.transform = `scaleX(${clamp01(fill)})`
    }
  }

  const scheduleFrame = (): void => {
    if (reducedMotionRef.current || frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame((nowMs) => {
      frameRef.current = null
      const currentTarget = targetRef.current
      const motions = motionsRef.current
      if (!currentTarget || !motions) return

      if (reducedMotionRef.current) {
        if (currentTarget.mode === 'segmented') {
          paintSegments(capVisualFills(
            currentTarget.placed,
            new Map(currentTarget.placed.map((segment) => [segment.id, segment.fill])),
            currentTarget.fraction
          ))
        } else {
          paintContinuous(currentTarget.fraction)
        }
        return
      }

      const shared = sharedRef.current
      if (shared) {
        // Share the frame clock, not a global fill multiplier: otherwise a
        // completed range shrinks whenever another range advances.
        advanceProgressMotion(shared, nowMs, currentTarget.fraction)
        if (currentTarget.mode === 'segmented') {
          paintSegments(paintSegmentMotions(motions.segments, currentTarget.placed, currentTarget.fraction, nowMs, !activeRef.current))
        } else {
          paintContinuous(Math.min(shared.progress, currentTarget.fraction))
        }
        if (Math.abs(shared.progress - currentTarget.fraction) > MOTION_EPSILON || currentTarget.placed.some(segment => Math.abs((motions.segments.get(segment.id)?.motion.progress ?? segment.fill) - segment.fill) > MOTION_EPSILON)) scheduleFrame()
        return
      }

      let moving = false
      if (currentTarget.mode === 'segmented') {
        paintSegments(paintSegmentMotions(motions.segments, currentTarget.placed, currentTarget.fraction, nowMs, !activeRef.current))
        moving = currentTarget.placed.some(segment => Math.abs((motions.segments.get(segment.id)?.motion.progress ?? segment.fill) - segment.fill) > MOTION_EPSILON)
      } else {
        const continuousTarget = currentTarget.fraction
        advanceProgressMotion(motions.continuous, nowMs, continuousTarget)
        moving = Math.abs(motions.continuous.progress - continuousTarget) > MOTION_EPSILON
        paintContinuous(Math.min(motions.continuous.progress, continuousTarget))
      }

      if (moving) scheduleFrame()
    })
  }

  const targetSignature = mode === 'segmented'
    ? `segmented:${safeFraction}:${placed.map((segment) => `${segment.id},${segment.left},${segment.width},${segment.fill}`).join(';')}`
    : `continuous:${safeFraction}`

  useEffect(() => {
    if (hostDriven || reducedMotion) {
      // In host-driven mode the Hero's single loop paints the bar; in
      // reduced-motion mode paint the settled fill once and stay static.
      if (reducedMotion) {
        if (mode === 'segmented') {
          paintSegments(capVisualFills(
            placed,
            new Map(placed.map((segment) => [segment.id, segment.fill])),
            safeFraction
          ))
        } else {
          paintContinuous(safeFraction)
        }
      }
      return
    }
    // Keep one persistent rAF loop alive. A 4Hz snapshot only changes its
    // target; it must not cancel and restart the in-flight interpolation.
    scheduleFrame()
    // The target signature, rather than the freshly-created placed array, keeps
    // internal 60Hz visual renders from restarting this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hostDriven, reducedMotion, targetSignature])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const paintHost = (shared: ProgressMotion, nowMs: number): void => {
    const currentTarget = targetRef.current
    if (!currentTarget) return
    if (currentTarget.mode === 'segmented') {
      paintSegments(paintSegmentMotions(motionsRef.current!.segments, currentTarget.placed, currentTarget.fraction, nowMs, !activeRef.current || reducedMotionRef.current))
    } else {
      paintContinuous(Math.min(shared.progress, currentTarget.fraction))
    }
  }
  useImperativeHandle(ref, () => ({
    paint: (shared, nowMs) => paintHost(shared, nowMs)
  }), [])

  const renderedProgress = reducedMotion
    ? safeFraction
    : clamp01(Math.min(
        (sharedMotion ?? motionsRef.current.continuous).progress,
        safeFraction
      ))
  let renderedFills: Map<number, number> | null = null
  if (showSegments) {
    renderedFills = paintSegmentMotions(motionsRef.current.segments, placed, safeFraction, null, reducedMotion || !active)
  }

  return (
    <div
      data-progress-flow={active && effects && safeFraction > 0 && safeFraction < 1 ? "active" : undefined}
      role="progressbar"
      aria-label={showSegments ? `${placed.length} 个分段的下载进度` : '下载进度'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safeFraction * 100)}
      className="relative h-1 overflow-hidden rounded-full bg-line shadow-[inset_0_0_0_1px_rgb(255_255_255/0.025)]"
      data-progress-style={showSegments ? 'segmented' : 'continuous'}
    >
      {showSegments ? (
        placed.map((segment) => (
          <div
            key={segment.id}
            className="absolute inset-y-0 overflow-hidden"
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
          >
            <div
              ref={(node) => {
                if (node) segmentFillRefs.current.set(segment.id, node)
                else segmentFillRefs.current.delete(segment.id)
              }}
              data-progress-fill
              className="relative h-full w-full bg-copper will-change-transform"
              style={{
                transform: `scaleX(${renderedFills?.get(segment.id) ?? 0})`,
                transformOrigin: 'left center'
              }}
            />
          </div>
        ))
      ) : (
        <div
          ref={continuousFillRef}
          data-progress-fill
          className="absolute inset-y-0 left-0 w-full bg-copper will-change-transform"
          style={{
            transform: `scaleX(${renderedProgress})`,
            transformOrigin: 'left center'
          }}
        />
      )}
    </div>
  )
}
