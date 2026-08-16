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

test('hard invariant: no column paints past the file’s true progress (the "looks almost done" regression)', () => {
  // The whole file is only 5% downloaded, but the engine momentarily reports
  // both fraction-only columns at 1.0 (range rebuild / flushing tail). Each
  // column keeps its own position but is bounded so it never extends past 5%.
  const out = placeSegments(
    [seg({ id: 0, fraction: 1 }), seg({ id: 1, fraction: 1 })],
    0,
    0.05
  )
  assert.equal(out.length, 2)
  for (const column of out) {
    const rightEdge = column.left + column.width * column.fill
    // A column may sit at its own left edge, but its painted right edge must
    // never cross the file's true progress (5% here).
    assert.ok(rightEdge <= Math.max(column.left, 5) + 1e-9, `right edge ${rightEdge} exceeded progress`)
  }
  // Column 0 (at the left) shows at most 5%; column 1 (starts at 50%) shows 0.
  assert.ok(out[0].fill <= 0.1 + 1e-9, `col0 fill ${out[0].fill} too high`)
  assert.equal(out[1].fill, 0, 'col1 (past 5%) must be empty')
})

test('hard invariant: positioned range cannot extend past whole-file progress', () => {
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
  for (const column of out) {
    const rightEdge = column.left + column.width * column.fill
    assert.ok(rightEdge <= Math.max(column.left, 10) + 1e-9, `right edge ${rightEdge} exceeded 10%`)
  }
  assert.ok(out[0].fill <= 0.2 + 1e-9, `col0 fill ${out[0].fill} too high`)
  assert.equal(out[1].fill, 0, 'col1 (past 10%) must be empty')
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
