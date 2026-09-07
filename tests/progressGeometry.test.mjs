import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeSegments, easedSegmentFill } from '../src/renderer/src/lib/progressGeometry.ts'

test('shared easing preserves completed segments while the whole file is incomplete', () => {
  assert.equal(easedSegmentFill(1, 0.5, 0.5), 1)
  assert.equal(easedSegmentFill(0.375, 0.5, 0.5), 0.375)
  assert.equal(easedSegmentFill(1, 0.5, 0.25), 0.5)
  assert.equal(easedSegmentFill(0.375, 0.5, 0.25), 0.1875)
  assert.equal(easedSegmentFill(0.375, 0.5, 0.7), 0.375)
  assert.equal(easedSegmentFill(1, 0, 0), 0)
})

test('tail split preserves the downloaded byte footprint at a settled animation phase', () => {
  const before = placeSegments([
    seg({ id: 0, start: 0, end: 19, completed: 20 }),
    seg({ id: 1, start: 20, end: 99, completed: 30 })
  ], 100, 0.5)
  const after = placeSegments([
    seg({ id: 0, start: 0, end: 19, completed: 20 }),
    seg({ id: 1, start: 20, end: 74, completed: 30 }),
    seg({ id: 2, start: 75, end: 99, completed: 0 })
  ], 100, 0.5)
  const footprints = rows => rows.map(row => [row.left, row.left + row.width * easedSegmentFill(row.fill, 0.5, 0.5)])
  assert.deepEqual(footprints(before), [[0, 20], [20, 50]])
  assert.deepEqual(footprints(after), [[0, 20], [20, 50], [75, 75]])
})

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

test('hard invariant: aggregate paint never exceeds file progress while every active range stays visible', () => {
  // The whole file is only 5% downloaded, but the engine momentarily reports
  // both fraction-only columns at 1.0 (range rebuild / flushing tail). Scale
  // them together: both connections remain visible, but their combined painted
  // area is exactly the file's truthful 5%.
  const out = placeSegments(
    [seg({ id: 0, fraction: 1 }), seg({ id: 1, fraction: 1 })],
    0,
    0.05
  )
  assert.equal(out.length, 2)
  const totalVisible = out.reduce((sum, column) => sum + column.width * column.fill, 0)
  assert.ok(Math.abs(totalVisible - 5) < 1e-9, `expected 5% aggregate, got ${totalVisible}%`)
  assert.ok(out[0].fill > 0, 'first connection should remain visible')
  assert.ok(out[1].fill > 0, 'tail connection should remain visible')
})

test('hard invariant: positioned ranges are scaled as a group when the host over-reports', () => {
  // File is 1000 bytes, only 100 downloaded. Engine reports two byte ranges
  // that together claim completion; the invariant bounds them to 10%.
  const out = placeSegments(
    [
      seg({ id: 0, start: 0, end: 499, completed: 500 }),
      seg({ id: 1, start: 500, end: 999, completed: 500 })
    ],
    1000,
    0.1
  )
  assert.equal(out.length, 2)
  const totalVisible = out.reduce((sum, column) => sum + column.width * column.fill, 0)
  assert.ok(Math.abs(totalVisible - 10) < 1e-9, `expected 10% aggregate, got ${totalVisible}%`)
  assert.equal(out[0].fill, 0.1)
  assert.equal(out[1].fill, 0.1)
})

test('parallel tail range can advance before the leading range finishes', () => {
  const out = placeSegments(
    [
      seg({ id: 0, start: 0, end: 499, completed: 50 }),
      seg({ id: 1, start: 500, end: 999, completed: 150 })
    ],
    1000,
    0.2
  )
  assert.equal(out[0].fill, 0.1)
  assert.equal(out[1].fill, 0.3)
  const totalVisible = out.reduce((sum, column) => sum + column.width * column.fill, 0)
  assert.ok(Math.abs(totalVisible - 20) < 1e-9, `expected 20% aggregate, got ${totalVisible}%`)
})

test('hard invariant: when file is fully done, columns may reach their right edge', () => {
  const out = placeSegments(
    [seg({ id: 0, fraction: 1 }), seg({ id: 1, fraction: 1 })],
    0,
    1
  )
  const totalVisible = out.reduce((sum, c) => sum + c.width * c.fill, 0)
  assert.ok(Math.abs(totalVisible - 100) < 1e-6, `expected full bar, got ${totalVisible}%`)
})
