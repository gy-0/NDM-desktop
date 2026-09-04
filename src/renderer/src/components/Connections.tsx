import { useEffect, useRef } from 'react'
import type { Segment } from '../lib/types'
import type { ProgressStyle } from '../lib/presentationPrefs'
import { placeSegments, type PlacedSegment } from '../lib/progressGeometry'
import { advanceProgressMotion, createProgressMotion, type ProgressMotion } from '../effects/metalforge/progressMotion'

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
  segments: Map<number, ProgressMotion>
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

function createMotions(target: ProgressTarget): ProgressMotions {
  const segments = new Map<number, ProgressMotion>()
  if (target.mode === 'segmented') {
    for (const segment of target.placed) segments.set(segment.id, createProgressMotion(segment.fill))
  }
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
  fraction,
  fileSize = 0,
  style
}: {
  segments: Segment[]
  fraction: number
  fileSize?: number
  style: ProgressStyle
}) {
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
  } else if (mode === 'segmented') {
    for (const segment of placed) {
      if (!motionsRef.current.segments.has(segment.id)) {
        motionsRef.current.segments.set(segment.id, createProgressMotion(segment.fill))
      }
    }
  }

  const frameRef = useRef<number | null>(null)
  const continuousFillRef = useRef<HTMLDivElement | null>(null)
  const segmentFillRefs = useRef(new Map<number, HTMLDivElement>())
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

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

      let moving = false
      if (currentTarget.mode === 'segmented') {
        const nextFills = new Map<number, number>()
        const activeIDs = new Set<number>()
        for (const segment of currentTarget.placed) {
          activeIDs.add(segment.id)
          let segmentMotion = motions.segments.get(segment.id)
          if (!segmentMotion) {
            segmentMotion = createProgressMotion(segment.fill)
            motions.segments.set(segment.id, segmentMotion)
          }
          const segmentTarget = clamp01(segment.fill)
          advanceProgressMotion(segmentMotion, nowMs, segmentTarget)
          nextFills.set(segment.id, clamp01(segmentMotion.progress))
          if (Math.abs(segmentMotion.progress - segmentTarget) > MOTION_EPSILON) moving = true
        }
        for (const id of motions.segments.keys()) {
          if (!activeIDs.has(id)) motions.segments.delete(id)
        }
        paintSegments(capVisualFills(currentTarget.placed, nextFills, currentTarget.fraction))
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
      return
    }
    // Keep one persistent rAF loop alive. A 4Hz snapshot only changes its
    // target; it must not cancel and restart the in-flight interpolation.
    scheduleFrame()
    // The target signature, rather than the freshly-created placed array, keeps
    // internal 60Hz visual renders from restarting this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, targetSignature])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const renderedProgress = reducedMotion
    ? safeFraction
    : clamp01(Math.min(motionsRef.current.continuous.progress, safeFraction))
  let renderedFills: Map<number, number> | null = null
  if (showSegments) {
    const fills = new Map<number, number>()
    for (const segment of placed) {
      const targetFill = clamp01(segment.fill)
      const currentFill = reducedMotion
        ? targetFill
        : Math.min(motionsRef.current.segments.get(segment.id)?.progress ?? targetFill, targetFill)
      fills.set(segment.id, clamp01(currentFill))
    }
    renderedFills = capVisualFills(placed, fills, safeFraction)
  }

  return (
    <div
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
              className="h-full w-full bg-copper will-change-transform"
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
