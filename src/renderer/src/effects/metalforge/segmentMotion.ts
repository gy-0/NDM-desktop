import type { PlacedSegment } from '../../lib/progressGeometry'
import { advanceProgressMotion, createProgressMotion, type ProgressMotion } from './progressMotion'

type SegmentMotion = { left: number; width: number; lastAuthoritativeFill: number; motion: ProgressMotion }
export type SegmentMotions = Map<number, SegmentMotion>
const clamp = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Each byte range owns its history; another range's advance cannot rewind it. */
export function paintSegmentMotions(
  motions: SegmentMotions, placed: PlacedSegment[], fraction: number,
  nowMs: number | null, settle = false
): Map<number, number> {
  const fills = new Map<number, number>()
  const ids = new Set<number>()
  for (const segment of placed) {
    ids.add(segment.id)
    const target = clamp(segment.fill)
    let entry = motions.get(segment.id)
    if (!entry || entry.left !== segment.left || entry.width !== segment.width || settle) {
      entry = { left: segment.left, width: segment.width, lastAuthoritativeFill: target, motion: createProgressMotion(target) }
      motions.set(segment.id, entry)
    }
    const motion = entry.motion
    // Corrections must be reflected by render as well as the next animation frame.
    if (target < entry.lastAuthoritativeFill || target < motion.progress) {
      motion.progress = target
      motion.targetProgress = target
    }
    entry.lastAuthoritativeFill = target
    if (nowMs !== null) {
      if (motion.lastNowMs === null) advanceProgressMotion(motion, nowMs, motion.targetProgress)
      advanceProgressMotion(motion, nowMs, target)
    }
    fills.set(segment.id, Math.min(target, motion.progress))
  }
  for (const id of motions.keys()) if (!ids.has(id)) motions.delete(id)
  const area = placed.reduce((sum, segment) => sum + Math.max(0, segment.width) * (fills.get(segment.id) ?? 0), 0)
  const allowed = clamp(fraction) * 100
  if (area > allowed && area > 0) {
    for (const [id, fill] of fills) fills.set(id, fill * allowed / area)
  }
  return fills
}
