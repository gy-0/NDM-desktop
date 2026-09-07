import assert from 'node:assert/strict'
import test from 'node:test'
import { paintSegmentMotions } from '../src/renderer/src/effects/metalforge/segmentMotion.ts'
const plan = (second) => [
  { id: 0, left: 0, width: 50, fill: 1 },
  { id: 1, left: 50, width: 50, fill: second }
]
test('completed segment stays full while another segment advances and total animation lags', () => {
  const motions = new Map()
  paintSegmentMotions(motions, plan(0), .5, 0)
  const fills = paintSegmentMotions(motions, plan(.2), .6, 250)
  assert.equal(fills.get(0), 1)
  assert.equal(fills.get(1), 0)
  const next = paintSegmentMotions(motions, plan(.2), .6, 266)
  assert.equal(next.get(0), 1)
  assert.ok(next.get(1) > 0 && next.get(1) < .2)
})

test('rollback is immediate in render and cannot replay as a climb', () => {
  const motions = new Map()
  paintSegmentMotions(motions, plan(.8), .9, 0)
  const corrected = paintSegmentMotions(motions, plan(.2), .6, null)
  assert.equal(corrected.get(1), .2)
  assert.equal(paintSegmentMotions(motions, plan(.2), .6, 250).get(1), .2)
})

test('pause and reduced motion settle every segment in a single paint', () => {
  const motions = new Map()
  paintSegmentMotions(motions, plan(0), .5, 0)
  paintSegmentMotions(motions, plan(.8), .9, 250)
  assert.equal(paintSegmentMotions(motions, plan(.8), .9, null, true).get(1), .8)
})

test('split ranges with reused IDs reset their fractions and removed ranges release history', () => {
  const motions = new Map()
  paintSegmentMotions(motions, plan(.8), .9, 0)
  const split = [{ id: 1, left: 50, width: 25, fill: 1 }, { id: 2, left: 75, width: 25, fill: 0 }]
  const fills = paintSegmentMotions(motions, split, .75, null)
  assert.equal(fills.get(1), 1)
  assert.equal(fills.get(2), 0)
  assert.equal(motions.has(0), false)
})

test('painted aggregate never exceeds the authoritative file fraction', () => {
  const motions = new Map()
  const fills = paintSegmentMotions(motions, plan(1), .4, 0)
  assert.ok([...fills.values()].reduce((sum, fill) => sum + fill * .5, 0) <= .4)
})

test('a new mounted task starts from its own snapshot', () => {
  const previous = new Map()
  paintSegmentMotions(previous, plan(1), 1, 0)
  const fresh = new Map()
  const fills = paintSegmentMotions(fresh, [{ id: 0, left: 0, width: 50, fill: .1 }, { id: 1, left: 50, width: 50, fill: 0 }], .05, null)
  assert.equal(fills.get(0), .1)
  assert.equal(fills.get(1), 0)
})

test('two render-only snapshots detect rollback without waiting for an animation frame', () => {
  const motions = new Map()
  paintSegmentMotions(motions, plan(0), .5, 0)
  assert.equal(paintSegmentMotions(motions, plan(.8), .9, null).get(1), 0)
  assert.equal(paintSegmentMotions(motions, plan(.2), .6, null).get(1), .2)
  assert.equal(paintSegmentMotions(motions, plan(.2), .6, 250).get(1), .2)
  assert.equal(paintSegmentMotions(motions, plan(.6), .8, null).get(1), .2)
})
