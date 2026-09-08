import test from 'node:test'
import assert from 'node:assert/strict'
import { createPauseSession, installWithRecovery } from './deploy-mac-lifecycle.mjs'
function fixture(initial) {
  const rows = structuredClone(initial), calls = []
  const rpc = async (op, fields) => {
    calls.push([op, fields?.taskID])
    if (op === 'list') return { ok: true, tasks: structuredClone(rows) }
    const task = rows.find(task => task.id === fields.taskID)
    if (op === 'pause') task.status = 'paused'
    if (op === 'resume') task.status = 'downloading'
    return { ok: true }
  }
  return { rows, calls, rpc }
}
test('only actual active tasks are paused and resumed; prior paused and waiting stay untouched', async () => {
  const f = fixture([{ id: 1, status: 'downloading', phase: 'merging' }, { id: 2, status: 'paused' }, { id: 3, status: 'waiting' }])
  const session = createPauseSession(f)
  await session.pauseActive(); await session.assertDrained(); await session.restore()
  assert.deepEqual([...session.pausedIDs], [1])
  assert.deepEqual(f.calls.filter(([op]) => op !== 'list'), [['pause', 1], ['resume', 1]])
  assert.equal(f.rows[1].status, 'paused'); assert.equal(f.rows[2].status, 'waiting')
})
test('completion races before pause and during drain never get resumed', async () => {
  for (const when of ['before', 'during']) {
    const f = fixture([{ id: 1, status: 'downloading' }]); let lists = 0
    const session = createPauseSession({ rpc: async (op, fields) => {
      if (op === 'list' && ++lists === 2 && when === 'before') f.rows[0].status = 'complete'
      const reply = await f.rpc(op, fields)
      if (op === 'pause' && when === 'during') f.rows[0].status = 'complete'
      return reply
    } })
    await session.pauseActive(); await session.restore()
    assert.equal(session.pausedIDs.size, 0)
    assert.ok(!f.calls.some(([op]) => op === 'resume'))
  }
})
test('pause timeout aborts even if persisted paused; confirmed pause can be recovered', async () => {
  const f = fixture([{ id: 1, status: 'downloading' }])
  const session = createPauseSession({ rpc: async (op, fields) => {
    const result = await f.rpc(op, fields)
    if (op === 'pause') throw Error('timeout')
    return result
  } })
  await assert.rejects(session.pauseActive(), /Could not confirm drained/)
  assert.deepEqual([...session.pausedIDs], [1])
  await session.restore(); assert.equal(f.rows[0].status, 'downloading')
})
test('still active after timeout is not marked paused and never force stopped', async () => {
  const f = fixture([{ id: 1, status: 'downloading' }])
  const session = createPauseSession({ rpc: async (op, fields) => { if (op === 'pause') throw Error('timeout'); return f.rpc(op, fields) } })
  await assert.rejects(session.pauseActive(), /no force quit/); assert.equal(session.pausedIDs.size, 0)
})
test('newly started tasks are drained individually, waiting ones remain waiting', async () => {
  const f = fixture([{ id: 1, status: 'downloading' }, { id: 2, status: 'waiting' }])
  const session = createPauseSession({ rpc: async (op, fields) => {
    const reply = await f.rpc(op, fields)
    if (op === 'pause' && fields.taskID === 1) f.rows[1].status = 'downloading'
    return reply
  } })
  await session.pauseActive(); assert.deepEqual([...session.pausedIDs], [1, 2])
})
test('resume failure is reported while recovery continues for other owned tasks', async () => {
  const f = fixture([{ id: 1, status: 'downloading' }, { id: 2, status: 'downloading' }])
  const session = createPauseSession({ rpc: async (op, fields) => op === 'resume' && fields.taskID === 1 ? { ok: false } : f.rpc(op, fields) })
  await session.pauseActive(); await assert.rejects(session.restore(), /task 1/)
  assert.equal(f.rows[0].status, 'paused'); assert.equal(f.rows[1].status, 'downloading')
})
function lifecycle(overrides = {}) {
  const events = []; let alive = true
  const session = { pausedIDs: new Set([1]), async pauseActive() { events.push('pause') }, async assertDrained() { events.push('drained') }, async restore() { events.push('resume') } }
  const ops = { session, running: () => alive, async quit() { events.push('quit'); alive = false }, async swap() { events.push('swap') }, async launch() { events.push('launch'); alive = true }, async healthy() { events.push('healthy'); return true }, async rollback() { events.push('rollback') }, async cleanupBackup() { events.push('cleanup') }, ...overrides }
  return { events, ops }
}
test('successful update resumes before deleting backup', async () => {
  const f = lifecycle(); await installWithRecovery(f.ops)
  assert.deepEqual(f.events, ['pause','drained','quit','swap','launch','healthy','resume','cleanup'])
})
test('unhealthy new app is normally stopped and old app restored before resuming', async () => {
  const f = lifecycle(); let checks = 0
  f.ops.healthy = async () => ++checks > 1
  await assert.rejects(installWithRecovery(f.ops), /New app did not become ready/)
  assert.deepEqual(f.events, ['pause','drained','quit','swap','launch','pause','drained','quit','rollback','launch','resume'])
})
test('quit cancelled leaves old bundle intact and restores only owned tasks', async () => {
  const f = lifecycle({ quit: async () => { throw Error('quit cancelled') } })
  await assert.rejects(installWithRecovery(f.ops), /quit cancelled/)
  assert.deepEqual(f.events, ['pause','drained','resume'])
})
test('swap failure rolls back before restoring tasks', async () => {
  const f = lifecycle({ swap: async () => { throw Error('rename failed') } })
  await assert.rejects(installWithRecovery(f.ops), /rename failed/)
  assert.deepEqual(f.events, ['pause','drained','quit','rollback','launch','healthy','resume'])
})
test('healthy new app resume failure preserves backup and does not interrupt successful resumptions', async () => {
  const f = lifecycle(); f.ops.session.restore = async () => { throw Error('resume task 1 failed') }
  await assert.rejects(installWithRecovery(f.ops), /resume task 1 failed/)
  assert.ok(!f.events.includes('rollback')); assert.ok(!f.events.includes('cleanup'))
})
test('unhealthy app refusing normal quit never gets swapped underneath its process', async () => {
  const f = lifecycle(); let quits = 0
  const quit = f.ops.quit
  f.ops.quit = async () => { if (++quits === 2) throw Error('cannot quit'); await quit() }
  f.ops.healthy = async () => false
  await assert.rejects(installWithRecovery(f.ops), /rollback could not be completed/)
  assert.ok(!f.events.includes('rollback')); assert.ok(!f.events.includes('cleanup'))
})

test('post-pause list failure is recovered by rechecking initially active issued IDs', async () => {
  for (const lostACK of [false, true]) {
    const f = fixture([{ id: 1, status: 'downloading' }, { id: 2, status: 'paused' }])
    let failNextList = false
    const session = createPauseSession({ rpc: async (op, fields) => {
      if (op === 'list' && failNextList) { failNextList = false; throw Error('temporary list failure') }
      const result = await f.rpc(op, fields)
      if (op === 'pause') {
        failNextList = true
        if (lostACK) throw Error('ACK lost')
      }
      return result
    } })
    await assert.rejects(session.pauseActive(), /temporary list failure/)
    assert.deepEqual([...session.attemptedIDs], [1])
    assert.equal(session.pausedIDs.size, 0)
    await session.restore()
    assert.deepEqual([...session.pausedIDs], [1])
    assert.equal(f.rows[0].status, 'downloading')
    assert.equal(f.rows[1].status, 'paused')
    assert.deepEqual(f.calls.filter(([op]) => op === 'resume'), [['resume', 1]])
  }
})
test('issued pause still cannot be verified during recovery is reported without blind resume', async () => {
  const f = fixture([{ id: 1, status: 'downloading' }]); let unavailable = false
  const session = createPauseSession({ rpc: async (op, fields) => {
    if (op === 'list' && unavailable) throw Error('engine unavailable')
    const result = await f.rpc(op, fields)
    if (op === 'pause') unavailable = true
    return result
  } })
  await assert.rejects(session.pauseActive(), /engine unavailable/)
  await assert.rejects(session.restore(), /task 1: engine unavailable/)
  assert.ok(!f.calls.some(([op]) => op === 'resume'))
})
test('old process exits after uncertain pause so attempted IDs trigger relaunch before recovery', async () => {
  const events = []; let alive = true
  const session = { pausedIDs: new Set(), attemptedIDs: new Set([1]),
    async pauseActive() { alive = false; throw Error('pause connection lost') },
    async restore() { events.push('restore') } }
  await assert.rejects(installWithRecovery({ session, running: () => alive,
    async launch() { events.push('launch'); alive = true }, async healthy() { return true },
    async swap() { assert.fail('Must not swap') }
  }), /pause connection lost/)
  assert.deepEqual(events, ['launch', 'restore'])
})
