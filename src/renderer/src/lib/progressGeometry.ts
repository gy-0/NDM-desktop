import type { Segment } from './types'

export interface PlacedSegment {
  id: number
  /** left edge as a percentage of the full bar (0..100) */
  left: number
  /** width as a percentage of the full bar (0..100) */
  width: number
  /** fill ratio of this segment's own slot (0..1) */
  fill: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/**
 * Lay out parallel download segments along the progress bar.
 *
 * Two real-world payloads must both render truthfully:
 *
 *  1. Positioned ranges — the engine reports `start`/`end` byte offsets and an
 *     optional `completed` byte count per segment. Segments are drawn at their
 *     exact byte positions. This is the precise view.
 *
 *  2. Fraction-only — the engine reports only `id` + `fraction` (each segment's
 *     own 0..1 progress) with no byte ranges (older/stale host builds do this).
 *     We distribute the segments as equal-width columns and fill each by its own
 *     fraction. Range downloads split the file into equal chunks, so equal width
 *     is a faithful approximation and keeps the multi-connection picture alive.
 *
 * Hard invariant: the sum of all painted segment areas may not exceed the
 * file's true overall progress (`fileFraction`). A parallel range near the end
 * of the file is allowed to advance before the first range finishes; clamping
 * every segment to a left-to-right frontier would hide real concurrent work.
 * When a stale engine snapshot over-reports the segments, scale their fills as
 * a group so the pattern remains visible while the aggregate stays truthful.
 */
export function placeSegments(
  segments: Segment[],
  fileSize = 0,
  fileFraction = 1
): PlacedSegment[] {
  const valid = segments.filter(
    (segment) => segment && Number.isFinite(segment.id)
  )
  if (valid.length === 0) return []

  // Case 1: at least two segments carry a real byte range → precise layout.
  const ranged = valid.filter(
    (segment) =>
      segment.start != null &&
      segment.end != null &&
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end >= segment.start
  )
  if (ranged.length > 1) {
    const total = Math.max(
      fileSize,
      ...ranged.map((segment) => (segment.end ?? 0) + 1),
      0
    )
    if (total > 0) {
      const placed = ranged.map((segment) => {
        const start = segment.start ?? 0
        const length = (segment.end ?? start) - start + 1
        const completed =
          segment.completed != null
            ? segment.completed
            : segment.fraction * length
        const rawLeft = (start / total) * 100
        const rawWidth = (length / total) * 100
        const ownFill = rawWidth > 0 ? clamp01(completed / length) : 0
        return {
          id: segment.id,
          left: rawLeft,
          width: rawWidth,
          fill: ownFill
        }
      })
      return capAggregateProgress(placed, fileFraction)
    }
  }

  // Case 2: fraction-only (or a single segment). Equal-width columns, each
  // filled by its own fraction. The aggregate cap below handles a stale host
  // snapshot without erasing later columns that are legitimately active.
  const count = valid.length
  const slot = 100 / count
  const placed = valid.map((segment, index) => {
    const rawLeft = index * slot
    const ownFill = clamp01(segment.fraction)
    return {
      id: segment.id,
      left: rawLeft,
      width: slot,
      fill: ownFill
    }
  })
  return capAggregateProgress(placed, fileFraction)
}

function capAggregateProgress(
  segments: PlacedSegment[],
  fileFraction: number
): PlacedSegment[] {
  const visiblePercent = segments.reduce(
    (sum, segment) => sum + segment.width * segment.fill,
    0
  )
  const allowedPercent = clamp01(fileFraction) * 100
  if (visiblePercent <= allowedPercent || visiblePercent <= 0) return segments

  const scale = allowedPercent / visiblePercent
  return segments.map((segment) => ({
    ...segment,
    fill: segment.fill * scale
  }))
}
