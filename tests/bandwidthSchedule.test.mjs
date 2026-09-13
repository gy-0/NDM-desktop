import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BandwidthScheduleController } from '../src/main/bandwidthSchedule.ts'
import { TemporaryBandwidthController } from '../src/main/temporaryBandwidth.ts'
import { activeBandwidthScheduleWindow, validateBandwidthScheduleRules } from '../src/shared/bandwidthSchedule.ts'

const local = (day, hour, minute = 0, second = 0) => new Date(2026, 8, day, hour, minute, second).getTime()
const rule = (id = 'work', patch = {}) => ({ id, name: id, enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', limitBytesPerSecond: 1_048_576, ...patch })
function clockAt(value = local(14, 10)) {
  let now = value
  const timers = new Map()
  let sequence = 0
  return { now: () => now, set(value) { now = value }, advance(ms) { now += ms },
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id },
    clearTimer(id) { timers.delete(id) }, timers }
}
function memoryStorage(initial = null) {
  let value = initial
  let fails = false
  return { read: () => value, write(text) { if (fails) throw new Error('disk unavailable'); value = text },
    failWrites(value) { fails = value } }
}
function harness(t, options = {}) {
  const clock = options.clock ?? clockAt()
  const storage = options.storage ?? memoryStorage()
  let limit = options.initialLimit ?? 0
  let temporary = false
  let writer = async value => { limit = value; return { ok: true } }
  let reader = async () => ({ limitBytesPerSecond: limit, temporaryActive: temporary })
  const writes = []
  let reads = 0
  const service = new BandwidthScheduleController({ statePath: '/unused/bandwidth-schedule.json', clock, storage,
    readState: async () => { reads++; return reader() },
    writeLimit: async value => { writes.push(value); return writer(value) } })
  t.after(() => service.stop())
  return { service, clock, storage, writes, get reads() { return reads }, get limit() { return limit },
    setLimit(value) { limit = value }, setTemporary(value) { temporary = value },
    setWriter(value) { writer = value }, setReader(value) { reader = value } }
}
async function save(h, rules = [rule()], enabled = true) {
  const reply = await h.service.handle('bandwidthScheduleSave', { expectedRevision: h.service.getSnapshot().revision, enabled, rules })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.state
}

test('weekly windows use inclusive starts, exclusive ends, start-day overnight ownership and list priority', () => {
  const normal = rule()
  assert.equal(activeBandwidthScheduleWindow([normal], new Date(local(14, 8, 59))), null)
  assert.equal(activeBandwidthScheduleWindow([normal], new Date(local(14, 9))).ruleID, 'work')
  assert.equal(activeBandwidthScheduleWindow([normal], new Date(local(14, 17))), null)
  assert.equal(activeBandwidthScheduleWindow([normal], new Date(local(19, 10))), null)
  const night = rule('night', { days: [1], start: '22:00', end: '02:00' })
  assert.equal(activeBandwidthScheduleWindow([night], new Date(local(15, 1))).windowKey, 'night:2026-09-14:22:00-02:00')
  assert.equal(activeBandwidthScheduleWindow([night], new Date(local(15, 2))), null)
  assert.equal(activeBandwidthScheduleWindow([night], new Date(local(15, 23))), null)
  const priority = rule('priority', { start: '10:00', end: '11:00', limitBytesPerSecond: 0 })
  assert.equal(activeBandwidthScheduleWindow([priority, normal], new Date(local(14, 10))).ruleID, 'priority')
  assert.equal(activeBandwidthScheduleWindow([normal, priority], new Date(local(14, 10))).ruleID, 'work')
  assert.equal(activeBandwidthScheduleWindow([{ ...priority, enabled: false }, normal], new Date(local(14, 10))).ruleID, 'work')
})

test('DST repeats and skipped hours are evaluated using the current local wall clock', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const repeated = rule('repeat', { days: [0], start: '01:30', end: '01:45' })
    assert.ok(activeBandwidthScheduleWindow([repeated], new Date('2026-11-01T05:35:00Z')))
    assert.equal(activeBandwidthScheduleWindow([repeated], new Date('2026-11-01T06:10:00Z')), null)
    assert.ok(activeBandwidthScheduleWindow([repeated], new Date('2026-11-01T06:35:00Z')))
    const skipped = rule('skip', { days: [0], start: '02:00', end: '03:00' })
    assert.equal(activeBandwidthScheduleWindow([skipped], new Date('2026-03-08T06:59:00Z')), null)
    assert.equal(activeBandwidthScheduleWindow([skipped], new Date('2026-03-08T07:00:00Z')), null)
    const crossing = rule('cross', { days: [6], start: '23:00', end: '03:30' })
    assert.equal(activeBandwidthScheduleWindow([crossing], new Date('2026-03-08T07:15:00Z')).windowKey, 'cross:2026-03-07:23:00-03:30')
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('invalid persisted and edited rules are rejected without changing bandwidth', async t => {
  const h = harness(t)
  for (const patch of [{ days: [] }, { days: [7] }, { days: [1, 1] }, { start: '24:00' }, { start: '9:00' },
    { end: '09:00' }, { limitBytesPerSecond: -1 }, { limitBytesPerSecond: 1.5 }, { name: '' }]) {
    assert.throws(() => validateBandwidthScheduleRules([rule('x', patch)]))
    const reply = await h.service.handle('bandwidthScheduleSave', { expectedRevision: 0, enabled: true, rules: [rule('x', patch)] })
    assert.equal(reply.ok, false)
  }
  assert.throws(() => validateBandwidthScheduleRules([rule('x'), rule('x')]))
  assert.deepEqual(h.writes, [])
  assert.equal(h.service.getSnapshot().revision, 0)
})

test('default disabled scheduling makes no engine calls and leaves unlimited and connection defaults alone', async t => {
  const h = harness(t)
  assert.equal((await h.service.start()).status, 'off')
  await save(h, [rule()], false)
  h.clock.set(local(14, 18))
  await h.service.reconcile()
  assert.equal(h.reads, 0)
  assert.deepEqual(h.writes, [])
  assert.equal(h.limit, 0)
})

test('acknowledged rules restore the original limit at window end and overlapping rules keep one baseline', async t => {
  const h = harness(t, { initialLimit: 12345, clock: clockAt(local(14, 9, 30)) })
  const rules = [rule('rush', { start: '10:00', end: '11:00', limitBytesPerSecond: 2_097_152 }), rule('work')]
  assert.equal((await save(h, rules)).appliedLimitBytesPerSecond, 1_048_576)
  h.clock.set(local(14, 10))
  assert.equal((await h.service.reconcile()).appliedLimitBytesPerSecond, 2_097_152)
  h.clock.set(local(14, 11))
  assert.equal((await h.service.reconcile()).appliedLimitBytesPerSecond, 1_048_576)
  h.clock.set(local(14, 17))
  const ended = await h.service.reconcile()
  assert.equal(ended.status, 'idle')
  assert.equal(ended.appliedLimitBytesPerSecond, null)
  assert.equal(h.limit, 12345)
  assert.deepEqual(h.writes, [1_048_576, 2_097_152, 1_048_576, 12345])
})

test('same-window failed RPCs retry with backoff and only ACK plus readback marks an application', async t => {
  const h = harness(t)
  let attempts = 0
  h.setWriter(async value => { if (++attempts === 1) throw new Error('offline'); h.setLimit(value); return { ok: true } })
  const failed = await save(h)
  assert.equal(failed.status, 'error')
  assert.equal(failed.appliedLimitBytesPerSecond, null)
  assert.equal(JSON.parse(h.storage.read()).lease.acknowledged, false)
  await h.service.reconcile()
  h.clock.advance(999)
  await h.service.reconcile()
  assert.equal(h.writes.length, 1)
  h.clock.advance(1)
  const recovered = await h.service.reconcile()
  assert.equal(recovered.status, 'scheduled')
  assert.equal(recovered.appliedLimitBytesPerSecond, 1_048_576)
  assert.equal(JSON.parse(h.storage.read()).lease.acknowledged, true)
  assert.equal(h.writes.length, 2)
})

test('lost ACK after an applied write is retried rather than adopted as confirmed state', async t => {
  const h = harness(t)
  let attempts = 0
  h.setWriter(async value => { h.setLimit(value); return { ok: ++attempts > 1 } })
  assert.equal((await save(h)).appliedLimitBytesPerSecond, null)
  assert.equal(h.limit, 1_048_576)
  h.clock.advance(1000)
  assert.equal((await h.service.reconcile()).status, 'scheduled')
  assert.deepEqual(h.writes, [1_048_576, 1_048_576])
})

test('a readback mismatch stays unconfirmed and an observed external change wins', async t => {
  const h = harness(t)
  h.setWriter(async () => { h.setLimit(777); return { ok: true } })
  const failed = await save(h)
  assert.equal(failed.status, 'error')
  assert.equal(failed.appliedLimitBytesPerSecond, null)
  h.clock.advance(1000)
  const next = await h.service.reconcile()
  assert.equal(next.status, 'overridden')
  assert.equal(h.limit, 777)
  assert.equal(JSON.parse(h.storage.read()).lease, null)
  assert.equal(h.writes.length, 1)
})

test('backoff grows within a failing window and a sleep/wake jump immediately reevaluates its end', async t => {
  const h = harness(t)
  h.setWriter(async () => { throw new Error('offline') })
  await save(h)
  assert.equal(h.service.getSnapshot().retryAt, h.clock.now() + 1000)
  h.clock.advance(1000)
  await h.service.reconcile()
  assert.equal(h.service.getSnapshot().retryAt, h.clock.now() + 2000)
  h.clock.advance(2000)
  await h.service.reconcile()
  assert.equal(h.service.getSnapshot().retryAt, h.clock.now() + 4000)
  h.clock.set(local(14, 18))
  const ended = await h.service.reconcile()
  assert.equal(ended.status, 'idle')
  assert.equal(h.limit, 0)
  assert.equal(JSON.parse(h.storage.read()).lease, null)
})

test('same-value manual takeover disarms restoration before RPC and lasts until the next window', async t => {
  const h = harness(t)
  await save(h)
  await h.service.runOverride('manual', async () => {
    assert.equal(JSON.parse(h.storage.read()).lease, null)
    h.setLimit(1_048_576)
  })
  assert.equal((await h.service.reconcile()).status, 'overridden')
  h.clock.set(local(14, 18))
  await h.service.reconcile()
  assert.equal(h.limit, 1_048_576)
  assert.equal(h.writes.length, 1)
  h.clock.set(local(15, 10))
  assert.equal((await h.service.reconcile()).status, 'scheduled')
  assert.equal(JSON.parse(h.storage.read()).lease.baseLimit, 1_048_576)
})

test('failed manual writes do not leave an old restoration or same-window retry armed', async t => {
  const h = harness(t)
  await save(h)
  await assert.rejects(h.service.runOverride('manual', async () => { throw new Error('manual RPC failed') }))
  assert.equal(JSON.parse(h.storage.read()).lease, null)
  h.clock.advance(120000)
  assert.equal((await h.service.reconcile()).status, 'overridden')
  h.clock.set(local(14, 18))
  await h.service.reconcile()
  assert.equal(h.limit, 1_048_576)
  assert.equal(h.writes.length, 1)
})

test('temporary limits suspend rules and expiration outside the window restores the genuine baseline', async t => {
  const h = harness(t)
  await save(h)
  await h.service.runOverride('temporary', async () => { h.setTemporary(true); h.setLimit(2_097_152) })
  assert.equal((await h.service.reconcile()).status, 'temporary')
  h.clock.set(local(14, 18))
  assert.equal((await h.service.reconcile()).status, 'temporary')
  assert.equal(h.limit, 2_097_152)
  // The temporary controller restores the scheduled value captured at its start.
  h.setLimit(1_048_576)
  h.setTemporary(false)
  assert.equal((await h.service.reconcile()).status, 'idle')
  assert.equal(h.limit, 0)
  assert.deepEqual(h.writes, [1_048_576, 0])
})

test('observed manual ownership cannot be resurrected by a failed journal write', async t => {
  const h = harness(t)
  await save(h)
  h.setLimit(888)
  h.storage.failWrites(true)
  assert.equal((await h.service.reconcile()).status, 'error')
  h.clock.set(local(14, 18))
  await h.service.reconcile()
  assert.equal(h.limit, 888)
  assert.equal(h.writes.length, 1)
  h.storage.failWrites(false)
  h.clock.advance(5000)
  await h.service.reconcile()
  assert.equal(JSON.parse(h.storage.read()).lease, null)
  assert.equal(h.limit, 888)
})

test('persisted ownership recovers after restart and never restores over an external new value', async t => {
  for (const external of [false, true]) {
    const first = harness(t)
    await save(first)
    await first.service.stop()
    const restarted = harness(t, { initialLimit: external ? 777 : first.limit, storage: first.storage, clock: clockAt(local(14, 18)) })
    const state = await restarted.service.start()
    assert.equal(state.status, 'idle')
    assert.equal(restarted.limit, external ? 777 : 0)
    assert.deepEqual(restarted.writes, external ? [] : [0])
  }
})

test('storage failure, invalid schema and revision conflicts cannot dispatch bandwidth changes', async t => {
  const h = harness(t)
  h.storage.failWrites(true)
  const failed = await h.service.handle('bandwidthScheduleSave', { expectedRevision: 0, enabled: true, rules: [rule()] })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'storage')
  assert.deepEqual(h.writes, [])
  assert.equal(h.service.getSnapshot().revision, 0)
  h.storage.failWrites(false)
  await save(h)
  const conflict = await h.service.handle('bandwidthScheduleSave', { expectedRevision: 0, enabled: false, rules: [] })
  assert.equal(conflict.code, 'conflict')
  assert.equal(h.limit, 1_048_576)
  for (const invalid of ['not-json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, revision: 0, enabled: true, rules: [rule()], lease: {}, manualWindowKey: null })]) {
    const broken = harness(t, { storage: memoryStorage(invalid) })
    assert.equal((await broken.service.start()).status, 'error')
    assert.deepEqual(broken.writes, [])
  }
})

test('manual updates queue behind an in-flight schedule RPC and permanently win that window', async t => {
  const h = harness(t)
  let release
  let entered
  const began = new Promise(resolve => { entered = resolve })
  h.setWriter(async value => { entered(); await new Promise(resolve => { release = resolve }); h.setLimit(value); return { ok: true } })
  const applying = save(h)
  await began
  assert.equal(h.service.getSnapshot().appliedLimitBytesPerSecond, null)
  const manual = h.service.runOverride('manual', async () => { h.setLimit(333) })
  release()
  await applying
  await manual
  assert.equal((await h.service.reconcile()).status, 'overridden')
  assert.equal(h.limit, 333)
})

test('an RPC that returns after a window ends is immediately corrected before reporting success', async t => {
  const h = harness(t, { clock: clockAt(local(14, 16, 59, 59)), initialLimit: 123 })
  h.setWriter(async value => {
    h.setLimit(value)
    if (value === 1_048_576) h.clock.set(local(14, 17))
    return { ok: true }
  })
  const state = await save(h)
  assert.equal(state.status, 'idle')
  assert.equal(state.appliedLimitBytesPerSecond, null)
  assert.equal(h.limit, 123)
  assert.deepEqual(h.writes, [1_048_576, 123])
})

test('a slow restore crossing into the next rule immediately applies the new window', async t => {
  const h = harness(t, { clock: clockAt(local(14, 16, 59)), initialLimit: 123 })
  await save(h, [rule(), rule('evening', { start: '17:01', end: '19:00', limitBytesPerSecond: 2_097_152 })])
  h.clock.set(local(14, 17))
  h.setWriter(async value => {
    h.setLimit(value)
    if (value === 123) h.clock.set(local(14, 17, 1))
    return { ok: true }
  })
  const state = await h.service.reconcile()
  assert.equal(state.status, 'scheduled')
  assert.equal(state.activeRule.ruleID, 'evening')
  assert.equal(state.appliedLimitBytesPerSecond, 2_097_152)
  assert.deepEqual(h.writes, [1_048_576, 123, 2_097_152])
})

test('real temporary controller auto-expiry and schedule reconciliation serialize without resurrecting a stale rule', async t => {
  const clock = clockAt(local(14, 9, 5))
  let limit = 0
  const writes = []
  const engine = { status: 'live', async request(op, extra) {
    if (op === 'getSettings') return { ok: true, settings: { bandwidthLimitBytesPerSecond: limit } }
    assert.equal(op, 'updateSettings')
    limit = extra.bandwidthLimitBytesPerSecond
    writes.push(limit)
    return { ok: true, settings: { bandwidthLimitBytesPerSecond: limit } }
  } }
  const temporary = new TemporaryBandwidthController({ engine, statePath: '/unused/temporary.json', storage: memoryStorage(), clock })
  const service = new BandwidthScheduleController({ statePath: '/unused/schedule.json', storage: memoryStorage(), clock,
    readState: async () => {
      await temporary.reconcile()
      const reply = await engine.request('getSettings')
      return { limitBytesPerSecond: reply.settings.bandwidthLimitBytesPerSecond, temporaryActive: temporary.getSnapshot().status !== 'inactive' }
    }, writeLimit: value => temporary.updateSettings({ bandwidthLimitBytesPerSecond: value }) })
  t.after(async () => { await service.stop(); await temporary.stop() })
  await temporary.start()
  await save({ service }, [rule('short', { end: '09:10' })])
  await service.runOverride('temporary', () => temporary.apply(2_097_152, 15))
  assert.equal((await service.reconcile()).status, 'temporary')
  assert.equal(limit, 2_097_152)
  clock.set(local(14, 9, 20))
  // Its internal timer may reconcile concurrently with the rule controller.
  await Promise.all([temporary.reconcile(), service.reconcile()])
  assert.equal(limit, 0)
  assert.equal(temporary.getSnapshot().status, 'inactive')
  assert.deepEqual(writes, [1_048_576, 2_097_152, 1_048_576, 0])
})

test('file persistence is versioned and acknowledged before application, and timers respect minute boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-schedule-'))
  const statePath = join(root, 'rules.json')
  const clock = clockAt(local(14, 10, 0, 59))
  let limit = 0
  const service = new BandwidthScheduleController({ statePath, clock,
    readState: async () => ({ limitBytesPerSecond: limit, temporaryActive: false }),
    writeLimit: async value => {
      const stored = JSON.parse(await readFile(statePath, 'utf8'))
      assert.equal(stored.version, 1)
      assert.equal(stored.lease.acknowledged, false)
      limit = value
      return { ok: true }
    } })
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }) })
  await save({ service })
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(stored.lease.acknowledged, true)
  assert.equal(stored.revision, 1)
  assert.ok([...clock.timers.values()].some(timer => timer.delay === 1000))
})
