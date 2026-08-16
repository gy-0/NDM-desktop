import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeSegments } from '../src/renderer/src/lib/progressGeometry.ts'

function seg(partial) {
  return {
    id: partial.id,
    fraction: partial.fraction ?? 0,
    start: partial.start,
    end: partial.end,
    completed: partial.completed
  }
}

test('positioned ranges: each column filled by its own bytes, not whole-file', () => {
  const out = placeSegments(
    [
      seg({ id: 0, start: 0, end: 9, completed: 5 }),
      seg({ id: 1, start: 10, end: 19, completed: 1 })
    ],
    20
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].left, 0)
  assert.equal(out[0].width, 50)
  assert.equal(out[0].fill, 0.5)
  assert.equal(out[1].left, 50)
  assert.equal(out[1].width, 50)
  assert.equal(out[1].fill, 0.1)
})

test('positioned ranges: a nearly-full file never paints both columns full if a segment lags', () => {
  const out = placeSegments(
    [
      seg({ id: 0, start: 0, end: 99, completed: 99 }),
      seg({ id: 1, start: 100, end: 199, completed: 2 })
    ],
    200
  )
  assert.equal(out[0].fill, 0.99)
  assert.equal(out[1].fill, 0.02)
})

test('fraction-only payload (live engine shape): equal columns, own fraction each', () => {
  const out = placeSegments([
    seg({ id: 0, fraction: 1 }),
    seg({ id: 2, fraction: 1 }),
    seg({ id: 6, fraction: 0 })
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].width, 100 / 3)
  assert.equal(out[1].width, 100 / 3)
  assert.equal(out[2].width, 100 / 3)
  assert.equal(out[0].fill, 1)
  assert.equal(out[1].fill, 1)
  assert.equal(out[2].fill, 0)
})

test('fraction-only does not collapse to a single bar (regression guard)', () => {
  const out = placeSegments([
    seg({ id: 0, fraction: 0.9 }),
    seg({ id: 1, fraction: 0.1 })
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].fill, 0.9)
  assert.equal(out[1].fill, 0.1)
})

test('single segment yields one column filled by its own fraction', () => {
  // Only one ranged segment -> no precise multi-column layout, but the lone
  // column must still reflect that segment's own progress, never the file's.
  const out = placeSegments([seg({ id: 0, start: 0, end: 49, completed: 25, fraction: 0.5 })], 50)
  assert.equal(out.length, 1)
  assert.equal(out[0].fill, 0.5)
})

test('empty input yields nothing', () => {
  assert.deepEqual(placeSegments([]), [])
})
