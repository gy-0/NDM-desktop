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
  accumulator: number
}

const STEP = 1 / 60
const PROGRESS_PER_SECOND = 0.325
const MAX_CATCH_UP_STEPS = 15

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

export function createProgressMotion(initialProgress: number): ProgressMotion {
  return {
    progress: clamp01(initialProgress),
    activity: 0,
    // Same deterministic out-of-phase starting clock used by style 1 (Slosh)
    // in the extracted host simulation.
    warp: ((1 * 2654435761) % 600) / 10,
    frames: 0,
    lastNowMs: null,
    accumulator: 0
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
    return motion
  }

  const elapsed = Math.max(0, Math.min(0.25, (nowMs - motion.lastNowMs) / 1000))
  motion.lastNowMs = nowMs
  motion.accumulator += elapsed

  let steps = Math.min(MAX_CATCH_UP_STEPS, Math.floor(motion.accumulator / STEP))
  if (steps === MAX_CATCH_UP_STEPS) motion.accumulator = 0
  else motion.accumulator -= steps * STEP

  while (steps > 0) {
    const gap = target - motion.progress
    const moving = Math.abs(gap) > 0.001
    if (moving) {
      motion.progress += Math.sign(gap) * Math.min(Math.abs(gap), PROGRESS_PER_SECOND * STEP)
    } else {
      motion.progress = target
    }

    const activityRate = moving ? 1.8 : 0.7
    motion.activity += ((moving ? 1 : 0) - motion.activity) * (1 - Math.exp(-activityRate * STEP))
    motion.warp += STEP * (0.45 + motion.activity * 0.85)
    motion.frames += 1
    steps -= 1
  }

  return motion
}
