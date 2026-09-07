import assert from 'node:assert/strict'
import test from 'node:test'
import { appendSpeedTelemetry, publishTaskTelemetry, subscribeTaskTelemetry } from '../src/renderer/src/lib/taskTelemetry.ts'

const sample = (at, bytesPerSecond = 1024, status = 'downloading') => ({ id: 1, at, bytesPerSecond, status })

test('stable real arrivals produce time samples, with no fabricated timers or EMA values', () => {
  let history = []
  for (const at of [1000, 1250, 1500, 1750, 2000]) history = appendSpeedTelemetry(history, sample(at))
  assert.deepEqual(history, [{ at: 1000, value: 1024 }, { at: 1500, value: 1024 }, { at: 2000, value: 1024 }])
  assert.equal(appendSpeedTelemetry(history, sample(2100, 9000)), history)
  history = appendSpeedTelemetry(history, sample(2500, 9000))
  assert.equal(history.at(-1).value, 9000)
})

test('history retains one predecessor outside 30 seconds and at most 64 samples', () => {
  let history = []
  for (let at = 0; at <= 40000; at += 500) history = appendSpeedTelemetry(history, sample(at))
  assert.equal(history[0].at, 9500)
  assert.equal(history[1].at, 10000)
  assert.ok(history.length <= 64)
  assert.deepEqual(appendSpeedTelemetry(history, sample(40001, 0, 'paused')), [])
})

test('clock corrections and telemetry gaps start fresh instead of freezing or inventing continuity', () => {
  const history = [{ at: 40000, value: 1024 }]
  assert.deepEqual(appendSpeedTelemetry(history, sample(90000, 512)), [{ at: 90000, value: 512 }])
  const corrected = appendSpeedTelemetry(history, sample(1000, 512))
  assert.deepEqual(corrected, [{ at: 1000, value: 512 }])
  assert.deepEqual(appendSpeedTelemetry(corrected, sample(1500, 600)), [{ at: 1000, value: 512 }, { at: 1500, value: 600 }])
})

test('telemetry only delivers matching subscribed IDs and stops after unsubscription', () => {
  const received = []
  const off = subscribeTaskTelemetry(1, value => received.push(value))
  publishTaskTelemetry({ id: 2, status: 'downloading' }, 1000, 123)
  publishTaskTelemetry({ id: 1, status: 'downloading' }, 1000, NaN)
  publishTaskTelemetry({ id: 1, status: 'downloading' }, 1000, undefined)
  publishTaskTelemetry({ id: 1, status: 'downloading' }, 1000, 123)
  off()
  publishTaskTelemetry({ id: 1, status: 'downloading' }, 1500, 123)
  assert.deepEqual(received, [sample(1000, 123)])
  const other = []
  const offOther = subscribeTaskTelemetry(2, value => other.push(value))
  publishTaskTelemetry({ id: 1, status: 'downloading' }, 2000, 321)
  publishTaskTelemetry({ id: 2, status: 'downloading' }, 2000, 321)
  offOther()
  assert.equal(other.length, 1)
  assert.equal(other[0].id, 2)
})
