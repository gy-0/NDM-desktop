/**
 * The host-side half of MetalForge Progress.
 *
 * The shader only draws the current front. The extracted design also advances
 * progress, activity and its warped clock at 60 Hz; feeding raw 4 Hz download
 * snapshots straight into the shader is what made 5% -> 10% visibly snap.
 * This is the design's manual-progress branch, tuned so one engine snapshot is
 * visually joined to the next before the following 250 ms snapshot arrives.
 */
export type ProgressMotion = {
  progress: number
  activity: number
  warp: number
  frames: number
  lastNowMs: number | null
  targetProgress: number
}

const PROGRESS_PER_SECOND = 0.325
const MAX_FRAME_DELTA = 1 / 30
const MOTION_EPSILON = 0.001

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

export function createProgressMotion(initialProgress: number): ProgressMotion {
  const progress = clamp01(initialProgress)
  return {
    progress,
    activity: 0,
    // Same deterministic out-of-phase starting clock used by style 1 (Slosh)
    // in the extracted host simulation.
    warp: ((1 * 2654435761) % 600) / 10,
    frames: 0,
    lastNowMs: null,
    targetProgress: progress
  }
}

export function advanceProgressMotion(
  motion: ProgressMotion,
  nowMs: number,
  targetProgress: number
): ProgressMotion {
  const target = clamp01(targetProgress)
  if (motion.lastNowMs == null) {
    motion.lastNowMs = nowMs
    motion.progress = target
    motion.targetProgress = target
    return motion
  }

  // A correction from the engine must be visible immediately. Interpolating a
  // rewind would leave the painted front ahead of the authoritative snapshot,
  // which is more misleading than a single backwards step.
  if (target < motion.progress) {
    motion.progress = target
    motion.targetProgress = target
    motion.lastNowMs = nowMs
    return motion
  }

  const previousTarget = motion.targetProgress
  const targetChanged = target !== previousTarget
  const wasSettled = Math.abs(motion.progress - previousTarget) <= MOTION_EPSILON
  motion.targetProgress = target

  // Connections suspends its rAF loop once it reaches the latest engine
  // snapshot. When a later snapshot wakes it, the elapsed quiet time is not
  // animation time: replaying it in one callback made the bar jump by as much
  // as fifteen hidden 60 Hz steps. Establish a new frame origin and let the
  // next repaint perform the first visible advance.
  if (targetChanged && wasSettled) {
    motion.lastNowMs = nowMs
    return motion
  }

  // Use the display timestamp directly so 90/120 Hz panels receive a distinct
  // progress value on every repaint. Cap a delayed frame rather than trying to
  // catch up all missed work at once, which would recreate the visible jump.
  const elapsed = Math.max(0, Math.min(MAX_FRAME_DELTA, (nowMs - motion.lastNowMs) / 1000))
  motion.lastNowMs = nowMs

  const gap = target - motion.progress
  const moving = Math.abs(gap) > MOTION_EPSILON
  if (moving) {
    motion.progress += Math.sign(gap) * Math.min(Math.abs(gap), PROGRESS_PER_SECOND * elapsed)
  } else {
    motion.progress = target
  }

  const activityRate = moving ? 1.8 : 0.7
  motion.activity += ((moving ? 1 : 0) - motion.activity) * (1 - Math.exp(-activityRate * elapsed))
  motion.warp += elapsed * (0.45 + motion.activity * 0.85)
  if (elapsed > 0) motion.frames += 1

  return motion
}
