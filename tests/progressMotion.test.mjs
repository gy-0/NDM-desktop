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
