import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngineEvents } from '../src/renderer/src/lib/engineEvents.ts'

test('large snapshots cross the bridge once for all UI consumers, preserving full and partial events', () => {
  let receive, starts = 0, stops = 0
  const subscribe = createEngineEvents({
    onEvent() { throw new Error('Must use serialized events') },
    onEventJSON(listener) { starts++; receive = listener; return () => { stops++ } }
  })
  const seen = Array.from({ length: 30 }, () => [])
  const unsubscribe = seen.map(events => subscribe(message => events.push(message)))
  assert.equal(starts, 1)
  const tasks = Array.from({ length: 3748 }, (_, id) => ({ id, filename: `任务-${id}.bin`, status: 'incomplete' }))
  receive(JSON.stringify({ op: 'snapshot', tasks }))
  receive(JSON.stringify({ op: 'snapshot', partial: true, tasks: [{ id: 3747, status: 'complete' }] }))
  receive(JSON.stringify({ op: 'installProgress', path: '/tmp/安装.dmg', phase: 'complete' }))
  for (const events of seen) {
    assert.equal(events.length, 3)
    assert.strictEqual(events[0], seen[0][0], 'Parsed snapshot shared inside the renderer')
    assert.deepEqual(events[0].tasks, tasks)
    assert.equal(events[1].partial, true)
    assert.equal(events[1].tasks[0].status, 'complete')
    assert.equal(events[2].path, '/tmp/安装.dmg')
  }
  for (const off of unsubscribe.slice(1)) off()
  assert.equal(stops, 0)
  receive(JSON.stringify({ op: 'snapshot', tasks: [] }))
  assert.equal(seen[0].length, 4)
  assert.equal(seen[1].length, 3)
  unsubscribe[0]()
  unsubscribe[0]()
  assert.equal(stops, 1)
  const off = subscribe(message => seen[0].push(message))
  assert.equal(starts, 2, 'Remount reconnects')
  receive(JSON.stringify({ op: 'temporaryBandwidthChanged' }))
  assert.equal(seen[0].length, 5)
  off()
  assert.equal(stops, 2)
})

test('legacy/mock event sources share one subscription and malformed serialized input is ignored', () => {
  let receive, starts = 0
  const seen = []
  const subscribe = createEngineEvents({ onEvent(listener) { starts++; receive = listener; return () => {} } })
  const off = subscribe(message => seen.push(message))
  const off2 = subscribe(message => seen.push(message))
  receive({ op: 'snapshot', tasks: [] })
  assert.equal(starts, 1)
  assert.equal(seen.length, 2)
  off(); off2()
  const serial = createEngineEvents({ onEvent() { throw new Error('legacy') }, onEventJSON(listener) { receive = listener; return () => {} } })
  const stop = serial(message => seen.push(message))
  for (const text of ['{', 'null', '[]', '12', '"snapshot"']) receive(text)
  assert.equal(seen.length, 2)
  receive('{"op":"snapshot","tasks":[]}')
  assert.equal(seen.length, 3)
  stop()
})
