import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceProgressMotion, createProgressMotion } from '../src/renderer/src/effects/metalforge/progressMotion.ts'

test('progress motion bridges 4Hz snapshots without restarting the track', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)

  advanceProgressMotion(motion, 250, 0.1)
  const first = motion.progress
  advanceProgressMotion(motion, 500, 0.2)
  const second = motion.progress

  assert.ok(first > 0 && first < 0.1)
  assert.ok(second > first && second < 0.2)
})

test('progress corrections rewind immediately to the authoritative snapshot', () => {
  const motion = createProgressMotion(0)
  advanceProgressMotion(motion, 0, 0)
  advanceProgressMotion(motion, 500, 0.5)
  assert.ok(motion.progress > 0)

  advanceProgressMotion(motion, 750, 0.02)
  assert.equal(motion.progress, 0.02)
})
