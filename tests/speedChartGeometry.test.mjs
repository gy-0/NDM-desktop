import assert from 'node:assert/strict'
import test from 'node:test'
import { speedChartGeometry, interpolateSpeedViewport, speedChartPeak } from '../src/renderer/src/lib/speedChartGeometry.ts'
test('first sample has no fabricated area before its timestamp', () => {
  assert.equal(speedChartGeometry([{at:30000,value:10}],30000,10).fill, '')
})
test('short observed history closes at its own first and last timestamps', () => {
  const chart=speedChartGeometry([{at:29000,value:5},{at:30000,value:10}],30000,10)
  assert.ok(chart.fill.endsWith(`L 283 66 L ${chart.points[0].x} 66 Z`))
})

test('empty history is empty even though the live speed label may have a value', () => {
  assert.deepEqual(speedChartGeometry([],30000,10), { points: [], line: '', fill: '' })
})
test('offscreen timestamps remain offscreen for clipping instead of becoming invented edge samples', () => {
  const chart=speedChartGeometry([{at:-1000,value:5},{at:31000,value:10}],30000,10)
  assert.ok(chart.points[0].x < 5)
  assert.ok(chart.points[1].x > 283)
})
test('window eviction keeps the preceding measured point and closes no earlier than real history', () => {
  const chart=speedChartGeometry([{at:0,value:3},{at:20000,value:5},{at:31000,value:10}],31000,10)
  assert.ok(chart.points[0].x < 5)
  assert.equal(chart.points[1].x,5 + 19000/30000*278)
})

test('new sample and peak changes animate the viewport, not measured speed values', () => {
  const from={end:30000,peak:10}, to={end:31000,peak:20}
  const middle=interpolateSpeedViewport(from,to,.5)
  assert.ok(middle.end>from.end && middle.end<to.end)
  assert.ok(middle.peak>from.peak && middle.peak<to.peak)
  const samples=[{at:29000,value:5},{at:30000,value:10},{at:31000,value:20}]
  const geometry=speedChartGeometry(samples,middle.end,middle.peak)
  assert.equal(geometry.points.length,3)
  for(let i=0;i<samples.length;i++) assert.ok(Math.abs((66-geometry.points[i].y)/56*middle.peak-samples[i].value)<1e-10)
  assert.deepEqual(interpolateSpeedViewport(middle,to,0),middle)
  assert.deepEqual(interpolateSpeedViewport(middle,to,1),to)
})

test('window peak includes the real left-edge line intersection, not the expired predecessor peak', () => {
  const samples=[{at:0,value:100},{at:10000,value:20},{at:35000,value:10}]
  const peak=speedChartPeak(samples,35000)
  assert.equal(peak,60)
  const chart=speedChartGeometry(samples,35000,peak)
  const fraction=(5-chart.points[0].x)/(chart.points[1].x-chart.points[0].x)
  const edgeY=chart.points[0].y+(chart.points[1].y-chart.points[0].y)*fraction
  assert.ok(Math.abs(edgeY-10)<1e-10)
})

test('all-zero observations report zero peak while plotting stays finite', () => {
  const samples=[{at:29000,value:0},{at:30000,value:0}]
  const peak=speedChartPeak(samples,30000)
  assert.equal(peak,0)
  assert.equal(speedChartPeak([],30000),0)
  const chart=speedChartGeometry(samples,30000,peak)
  assert.ok(chart.points.every(point => Number.isFinite(point.x) && point.y===66))
})
