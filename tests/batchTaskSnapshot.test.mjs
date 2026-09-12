import assert from 'node:assert/strict'
import test from 'node:test'
import { getTaskPauseTargets, setTaskPaused, startClock } from '../src/renderer/src/lib/store.ts'

const row = (id, status) => ({ id, status, filename: `File-${id}.bin`, category: 'misc', url: `https://example.com/${id}` })

function fixture() {
  const original = globalThis.window
  let listener
  let authoritative = [row(1, 'downloading'), row(2, 'downloading'), row(3, 'paused'), row(4, 'complete'), row(5, 'waiting'), row(6, 'incomplete')]
  let listFails = false
  let failID
  const calls = []
  globalThis.window = { ndm: {
    request: async (op, extra) => {
      calls.push({ op, ...extra })
      if (op === 'list') return listFails ? { ok: false } : { ok: true, tasks: authoritative }
      if (extra.taskID === failID) return { ok: false }
      authoritative = authoritative.map(task => task.id === extra.taskID ? { ...task, status: op === 'pause' ? 'paused' : 'downloading' } : task)
      return { ok: true }
    },
    status: async () => 'down', getEngineError: async () => null,
    onEvent: callback => { listener = callback; return () => {} }, onStatus: () => () => {}, notifySnapshot: () => {}
  } }
  const stop = startClock()
  return {
    calls,
    push: rows => listener({ op: 'snapshot', tasks: rows }),
    listFails: () => { listFails = true },
    fail: id => { failID = id },
    close: () => { stop(); globalThis.window = original }
  }
}

test('a batch uses one acknowledged list and pauses running rows even when their displayed snapshot is old', async () => {
  const f = fixture()
  try {
    await Promise.resolve() // Drain the initial clock fetch before imposing the old display snapshot.
    f.push([row(1, 'downloading'), row(2, 'paused'), row(3, 'paused'), row(4, 'complete'), row(5, 'waiting'), row(6, 'incomplete')])
    f.calls.length = 0
    const targets = await getTaskPauseTargets([1, 2, 2, 3, 4, 5, 6, 999], true)
    assert.deepEqual(targets.map(task => task.id), [1, 2, 5])
    for (const target of targets) await setTaskPaused(target.id, true, target)
    assert.deepEqual(f.calls, [{ op: 'list' }, { op: 'pause', taskID: 1 }, { op: 'pause', taskID: 2 }, { op: 'pause', taskID: 5 }])
    assert.deepEqual(await getTaskPauseTargets([1, 2, 3, 4, 5, 6], true), [], 'A repeated pause must not spray commands at already parked rows')
    assert.equal(f.calls.filter(call => call.op === 'pause').length, 3)
  } finally { f.close() }
})

test('resume skips authoritative complete, running and waiting rows even if the displayed rows say paused', async () => {
  const f = fixture()
  try {
    await Promise.resolve()
    f.push([1, 2, 3, 4, 5, 6].map(id => row(id, 'paused')))
    f.calls.length = 0
    const targets = await getTaskPauseTargets([1, 2, 3, 4, 5, 6], false)
    assert.deepEqual(targets.map(task => task.id), [3, 6])
    for (const target of targets) await setTaskPaused(target.id, false, target)
    assert.deepEqual(f.calls, [{ op: 'list' }, { op: 'resume', taskID: 3 }, { op: 'resume', taskID: 6 }])
  } finally { f.close() }
})

test('a failed authoritative read sends no commands and failed command acknowledgements stay failures', async () => {
  const f = fixture()
  try {
    await Promise.resolve()
    f.calls.length = 0
    const targets = await getTaskPauseTargets([1, 2], true)
    f.fail(2)
    await setTaskPaused(1, true, targets[0])
    await assert.rejects(setTaskPaused(2, true, targets[1]), /未能暂停任务/)
    f.listFails()
    f.calls.length = 0
    await assert.rejects(getTaskPauseTargets([1, 2], true), /未能获取任务状态/)
    assert.deepEqual(f.calls, [{ op: 'list' }])
  } finally { f.close() }
})
