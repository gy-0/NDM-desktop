import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CompletionActionService } from '../src/main/completionAction.ts'

const task = (id, status = 'downloading', extra = {}) => ({ id, status, ...extra })
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function harness(t, initial = [task(1)], options = {}) {
  let tasks = initial
  let now = 1000
  const performed = []
  const service = new CompletionActionService({ listTasks: () => tasks,
    perform: action => { performed.push(action) }, now: () => now,
    pollIntervalMs: 10_000, ...options })
  t.after(() => service.dispose())
  return { service, performed, setTasks(value) { tasks = value }, setNow(value) { now = value } }
}
const status = async service => (await service.handle('completionActionStatus')).state
async function arm(service, action = 'sleep', delaySeconds = 30) {
  const reply = await service.handle('completionActionArm', { action, delaySeconds })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.state.phase, 'armed')
  assert.equal(reply.state.oneShot, true)
  return reply.state
}

test('completion actions default off and historical completed or empty lists cannot arm', async t => {
  for (const tasks of [[], [task(99, 'complete')]]) {
    const h = harness(t, tasks)
    assert.equal((await status(h.service)).phase, 'off')
    assert.equal((await h.service.handle('completionActionArm', { action: 'shutdown', delaySeconds: 60 })).code, 'noPendingTasks')
    h.setNow(999999)
    await h.service.checkNow()
    assert.deepEqual(h.performed, [])
  }
})

test('arming requires an explicit supported action and an integer 30–300 second delay', async t => {
  const h = harness(t)
  for (const input of [{}, { action: 'restart', delaySeconds: 60 }, { action: 'sleep', delaySeconds: 29 },
    { action: 'sleep', delaySeconds: 301 }, { action: 'sleep', delaySeconds: 30.5 },
    { action: 'sleep', delaySeconds: '60' }, { action: 'sleep' }]) {
    assert.equal((await h.service.handle('completionActionArm', input)).code, 'invalidRequest')
  }
  await arm(h.service, 'quit', 300)
  assert.equal((await h.service.handle('completionActionArm', { action: 'shutdown', delaySeconds: 30 })).code, 'alreadyArmed')
  assert.deepEqual(h.performed, [])
})

test('waiting, paused, failed, incomplete, unknown and recording tasks block every power action', async t => {
  const h = harness(t, [task(1), task(99, 'complete')])
  const armed = await arm(h.service)
  assert.deepEqual(armed.trackedTaskIDs, [1])
  for (const value of [task(1, 'waiting'), task(1, 'paused'), task(1, 'error'), task(1, 'incomplete'),
    task(1, 'merging'), task(1, 'complete', { isLiveRecording: true })]) {
    h.setTasks([value, task(99, 'complete')])
    h.setNow(999999)
    const state = await status(h.service)
    assert.equal(state.phase, 'armed', JSON.stringify(value))
    assert.equal(state.remainingTaskCount, 1)
    assert.equal(state.countdownEndsAt, undefined)
    assert.deepEqual(h.performed, [])
  }
  h.setTasks([task(1, 'complete'), task(99, 'complete')])
  assert.equal((await status(h.service)).phase, 'countdown')
})

test('all tracked files complete before a full countdown and the action is consumed once', async t => {
  for (const action of ['sleep', 'quit', 'shutdown']) {
    const h = harness(t)
    await arm(h.service, action)
    h.setTasks([task(1, 'complete')])
    assert.equal((await status(h.service)).countdownEndsAt, 31000)
    h.setNow(30999)
    assert.equal((await status(h.service)).phase, 'countdown')
    assert.deepEqual(h.performed, [])
    h.setNow(31000)
    const done = await status(h.service)
    assert.equal(done.phase, 'completed')
    assert.equal(done.consumedAt, 31000)
    assert.equal(done.countdownEndsAt, undefined)
    await h.service.checkNow()
    await status(h.service)
    assert.deepEqual(h.performed, [action])
  }
})

test('new tasks and restarted historical tasks stop a countdown and must finish first', async t => {
  const h = harness(t, [task(1), task(99, 'complete')])
  await arm(h.service)
  h.setTasks([task(1, 'complete'), task(99, 'complete')])
  assert.equal((await status(h.service)).phase, 'countdown')
  h.setNow(30000)
  h.setTasks([task(1, 'complete'), task(99, 'complete'), task(2, 'waiting')])
  const interrupted = await status(h.service)
  assert.equal(interrupted.phase, 'armed')
  assert.deepEqual(interrupted.trackedTaskIDs, [1, 2])
  assert.equal(interrupted.countdownEndsAt, undefined)
  h.setNow(90000)
  h.setTasks([task(1, 'complete'), task(99, 'complete'), task(2, 'complete')])
  assert.equal((await status(h.service)).countdownEndsAt, 120000)
  h.setTasks([task(1, 'complete'), task(99, 'paused'), task(2, 'complete')])
  assert.deepEqual((await status(h.service)).trackedTaskIDs, [1, 2, 99])
  assert.equal((await status(h.service)).phase, 'armed')
  assert.deepEqual(h.performed, [])
})

test('a new task already complete between snapshots still restarts the entire countdown', async t => {
  const h = harness(t)
  await arm(h.service)
  h.setTasks([task(1, 'complete')])
  await status(h.service)
  h.setNow(30000)
  h.setTasks([task(1, 'complete'), task(2, 'complete')])
  const restarted = await status(h.service)
  assert.deepEqual(restarted.trackedTaskIDs, [1, 2])
  assert.equal(restarted.countdownEndsAt, 60000)
  assert.deepEqual(h.performed, [])
})

test('removing a tracked task or returning an empty snapshot never counts as completion', async t => {
  const h = harness(t, [task(1), task(2)])
  await arm(h.service)
  for (const snapshot of [[task(1, 'complete')], []]) {
    h.setTasks(snapshot)
    h.setNow(999999)
    const state = await status(h.service)
    assert.equal(state.phase, 'armed')
    assert.equal(state.reason, 'taskMissing')
    assert.deepEqual(h.performed, [])
  }
})

test('the final authoritative check catches a task that starts at the countdown deadline', async t => {
  let snapshots = [task(1)]
  let addAtNextFinalCheck = false
  let calls = 0
  const h = harness(t, [], { listTasks: () => {
    calls++
    if (addAtNextFinalCheck && calls % 2 === 0) snapshots = [task(1, 'complete'), task(2)]
    return snapshots
  } })
  await arm(h.service)
  snapshots = [task(1, 'complete')]
  await status(h.service)
  // Arm and initial completion consumed 2 reads. At the deadline the first
  // snapshot is complete, but the mandatory second read returns new work.
  addAtNextFinalCheck = true
  h.setNow(31000)
  const state = await status(h.service)
  assert.equal(calls, 4)
  assert.equal(state.phase, 'armed')
  assert.equal(state.remainingTaskCount, 1)
  assert.deepEqual(h.performed, [])
})

test('unavailable or malformed snapshots stop the countdown; recovery starts a fresh delay', async t => {
  let snapshot = [task(1)]
  let broken = false
  const h = harness(t, [], { listTasks: () => { if (broken) throw new Error('engine disconnected'); return snapshot } })
  await arm(h.service)
  snapshot = [task(1, 'complete')]
  await status(h.service)
  h.setNow(31000)
  broken = true
  const blocked = await status(h.service)
  assert.equal(blocked.phase, 'armed')
  assert.equal(blocked.reason, 'snapshotUnavailable')
  assert.equal(blocked.countdownEndsAt, undefined)
  broken = false
  for (const invalid of [null, [task(1, 'complete'), task(1, 'complete')], [task(-1, 'complete')], [{ id: 1 }]]) {
    snapshot = invalid
    assert.equal((await status(h.service)).reason, 'snapshotUnavailable')
  }
  snapshot = [task(1, 'complete')]
  h.setNow(90000)
  assert.equal((await status(h.service)).countdownEndsAt, 120000)
  assert.deepEqual(h.performed, [])
})

test('cancel invalidates in-flight snapshots and no stale reply can arm or execute', async t => {
  let release
  const h = harness(t, [], { listTasks: () => new Promise(resolve => { release = resolve }) })
  const arming = h.service.handle('completionActionArm', { action: 'shutdown', delaySeconds: 30 })
  assert.equal((await h.service.handle('completionActionCancel')).state.phase, 'off')
  release([task(1)])
  assert.equal((await arming).code, 'cancelled')
  h.setNow(999999)
  assert.equal((await status(h.service)).phase, 'off')
  assert.deepEqual(h.performed, [])

  const second = harness(t)
  await arm(second.service)
  second.setTasks([task(1, 'complete')])
  await status(second.service)
  await second.service.handle('completionActionCancel')
  second.setNow(999999)
  assert.equal((await status(second.service)).phase, 'off')
  assert.deepEqual(second.performed, [])
})

test('platform errors consume the action and provide an explicit failure without automatic retry', async t => {
  let calls = 0
  const h = harness(t, [task(1)], { perform: () => { calls++; throw new Error('private OS diagnostic') } })
  await arm(h.service, 'shutdown')
  h.setTasks([task(1, 'complete')])
  await status(h.service)
  h.setNow(31000)
  const failed = await status(h.service)
  assert.equal(failed.phase, 'error')
  assert.match(failed.error, /系统权限/)
  assert.equal(failed.error.includes('private OS diagnostic'), false)
  assert.equal(failed.consumedAt, 31000)
  h.setNow(999999)
  await status(h.service)
  assert.equal(calls, 1)
  assert.equal((await h.service.handle('completionActionArm', { action: 'sleep', delaySeconds: 30 })).code, 'noPendingTasks')
})

test('the consumed state is observable before perform resolves and concurrent checks cannot repeat it', async t => {
  let release
  let started
  const began = new Promise(resolve => { started = resolve })
  let calls = 0
  const h = harness(t, [task(1)], { perform: () => { calls++; started(); return new Promise(resolve => { release = resolve }) } })
  await arm(h.service)
  h.setTasks([task(1, 'complete')])
  await status(h.service)
  h.setNow(31000)
  const executing = h.service.checkNow()
  await began
  const state = await status(h.service)
  assert.equal(state.phase, 'executing')
  assert.equal(state.consumedAt, 31000)
  assert.equal((await h.service.handle('completionActionCancel')).code, 'actionInProgress')
  await h.service.checkNow()
  release()
  await executing
  assert.equal((await status(h.service)).phase, 'completed')
  assert.equal(calls, 1)
})

test('disposed and newly constructed services never resume an armed power action', async t => {
  const h = harness(t)
  await arm(h.service)
  h.service.dispose()
  h.setTasks([task(1, 'complete')])
  h.setNow(999999)
  await h.service.checkNow()
  assert.equal((await status(h.service)).phase, 'off')
  assert.equal((await h.service.handle('completionActionArm', { action: 'quit', delaySeconds: 30 })).code, 'shuttingDown')
  assert.deepEqual(h.performed, [])
  const reopened = harness(t, [task(1, 'complete')])
  assert.equal((await status(reopened.service)).phase, 'off')
})

test('armed monitoring runs automatically without an open settings panel', async t => {
  const h = harness(t, [task(1)], { pollIntervalMs: 100 })
  await arm(h.service, 'quit')
  h.setTasks([task(1, 'complete')])
  await sleep(140)
  h.setNow(31000)
  await sleep(140)
  assert.deepEqual(h.performed, ['quit'])
})
