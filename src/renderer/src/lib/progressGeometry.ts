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
 * Hard invariant: no segment's right edge may advance past the file's true
 * overall progress (`fileFraction`). The engine can momentarily over-report a
 * segment (range rebuild, a finished tail segment still flushing) and without
 * this clamp a partially downloaded file would briefly paint every column full
 * — exactly the "looks almost done" illusion this module exists to prevent.
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

  const fileRight = clamp01(fileFraction) * 100

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
      return ranged.map((segment) => {
        const start = segment.start ?? 0
        const length = (segment.end ?? start) - start + 1
        const completed =
          segment.completed != null
            ? segment.completed
            : segment.fraction * length
        const rawLeft = (start / total) * 100
        const rawWidth = (length / total) * 100
        // Own progress for this column, then bound its right edge by the
        // file's true progress so a segment can never look downloaded past
        // what the file has actually received.
        const ownFill = rawWidth > 0 ? clamp01(completed / length) : 0
        const allowedFill = rawWidth > 0 ? clamp01((fileRight - rawLeft) / rawWidth) : 0
        return {
          id: segment.id,
          left: rawLeft,
          width: rawWidth,
          fill: Math.min(ownFill, allowedFill)
        }
      })
    }
  }

  // Case 2: fraction-only (or a single segment). Equal-width columns, each
  // filled by its own fraction. Never reads the whole-file progress, but the
  // right edge of every column is still bounded by the file's real progress.
  const count = valid.length
  const slot = 100 / count
  return valid.map((segment, index) => {
    const rawLeft = index * slot
    const ownFill = clamp01(segment.fraction)
    const allowedFill = slot > 0 ? clamp01((fileRight - rawLeft) / slot) : 0
    return {
      id: segment.id,
      left: rawLeft,
      width: slot,
      fill: Math.min(ownFill, allowedFill)
    }
  })
}
