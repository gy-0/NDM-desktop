import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceProgressMotion, createProgressMotion } from '../src/renderer/src/effects/metalforge/progressMotion.ts'

test('progress motion bridges 4Hz snapshots without restarting the track', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)

  advanceProgressMotion(motion, 250, 0.1)
  advanceProgressMotion(motion, 266, 0.1)
  const first = motion.progress
  advanceProgressMotion(motion, 500, 0.2)
  const second = motion.progress

  assert.ok(first > 0 && first < 0.1)
  assert.ok(second > first && second < 0.2)
})

test('progress corrections rewind immediately to the authoritative snapshot', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)
  advanceProgressMotion(motion, 250, 0.5)
  advanceProgressMotion(motion, 266, 0.5)
  advanceProgressMotion(motion, 500, 0.5)
  assert.ok(motion.progress > 0)

  advanceProgressMotion(motion, 750, 0.002)
  assert.equal(motion.progress, 0.002)
})

test('a new snapshot after an idle gap starts a fresh frame instead of jumping', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)

  // The visual track is settled, then the engine stays quiet for 250 ms.
  // That quiet time must not be replayed as fifteen hidden 60 Hz steps in the
  // first visible frame of the next snapshot.
  advanceProgressMotion(motion, 250, 0.1)
  assert.equal(motion.progress, 0)

  advanceProgressMotion(motion, 258, 0.1)
  assert.ok(motion.progress > 0)
  assert.ok(motion.progress < 0.01)
})

test('progress advances on every high-refresh frame using elapsed time', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)
  advanceProgressMotion(motion, 250, 0.1)

  advanceProgressMotion(motion, 258, 0.1)
  const first = motion.progress
  advanceProgressMotion(motion, 266, 0.1)
  const second = motion.progress

  assert.ok(first > 0)
  assert.ok(second > first)
})

test('a large forward target after a long quiet gap never overshoots or jumps', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)
  // The engine stays silent for 250 ms and then reports 0.9: the idle time must
  // not be replayed as animation, and every frame must ease toward the target
  // from below without ever passing it.
  advanceProgressMotion(motion, 250, 0.9)
  assert.equal(motion.progress, 0)

  let previous = motion.progress
  let now = 250
  for (let step = 0; step < 60; step += 1) {
    now += 16.6
    advanceProgressMotion(motion, now, 0.9)
    assert.ok(motion.progress > previous, `frame ${step} should advance`)
    assert.ok(motion.progress <= 0.9, `frame ${step} must not overshoot`)
    previous = motion.progress
  }
})

test('a zero-elapsed frame keeps progress finite and never negative', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)
  advanceProgressMotion(motion, 250, 0.5)
  const before = motion.progress

  // A repaint with an identical timestamp (elapsed clamps to 0) must not
  // inject NaN, rewind the front, or corrupt later easing.
  advanceProgressMotion(motion, 250, 0.5)
  assert.equal(motion.progress, before)
  assert.ok(Number.isFinite(motion.progress))
  assert.ok(motion.progress >= 0)
  assert.ok(Number.isFinite(motion.warp))

  // The next real frame still eases forward from the preserved value.
  advanceProgressMotion(motion, 266, 0.5)
  assert.ok(motion.progress > before)
  assert.ok(motion.progress <= 0.5)
})

test('settled progress keeps a liquid clock without inventing downloaded bytes', () => {
  const motion = createProgressMotion(0.4)
  advanceProgressMotion(motion, 0, 0.4)
  const clock = motion.warp
  for (let frame = 1; frame <= 120; frame++) advanceProgressMotion(motion, frame * 1000 / 60, 0.4)
  assert.equal(motion.progress, 0.4)
  assert.ok(motion.warp > clock + 0.8)
})
