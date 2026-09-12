import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TemporaryBandwidthController, temporaryBandwidthStatePath } from '../src/main/temporaryBandwidth.ts'

const MB = 1024 * 1024
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ limit = 0, contents = null } = {}) {
  let text = contents
  let now = 1_000_000
  let nextTimer = 0
  const timers = new Map()
  const changes = []
  const storage = {
    read: () => { if (storage.failRead) throw new Error('read failure'); return text },
    write: value => { if (storage.fail) throw new Error('disk failure'); text = value },
    fail: false, failRead: false
  }
  const engine = {
    status: 'live', limit, calls: [], read: null, write: null,
    async request(op, extra = {}) {
      engine.calls.push({ op, ...extra })
      if (op === 'getSettings') return engine.read ? await engine.read() : { ok: true, settings: { bandwidthLimitBytesPerSecond: engine.limit } }
      if (op === 'updateSettings') {
        if (engine.write) return await engine.write(extra)
        if (extra.bandwidthLimitBytesPerSecond !== undefined) engine.limit = extra.bandwidthLimitBytesPerSecond
        return { ok: true, settings: { bandwidthLimitBytesPerSecond: engine.limit } }
      }
      throw new Error('unexpected operation')
    }
  }
  const clock = {
    now: () => now,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id },
    clearTimer: id => timers.delete(id)
  }
  const create = () => new TemporaryBandwidthController({ engine, statePath: '/unused-fixture', storage, clock, onChange: state => changes.push(state) })
  return {
    engine, storage, clock, timers, changes, create,
    contents: () => text,
    now: () => now,
    jump: milliseconds => { now += milliseconds },
    async fireTimer() {
      const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      assert.ok(first, 'expected a recovery timer')
      timers.delete(first[0]); now = Math.max(now, first[1].at); first[1].callback(); await flush()
    },
    writes: () => engine.calls.filter(call => call.op === 'updateSettings')
  }
}

test('temporary limit saves the actual previous value and restores without a renderer', async () => {
  const f = fixture({ limit: 2 * MB }); const controller = f.create()
  const state = await controller.apply(5 * MB, 15)
  assert.equal(state.status, 'active')
  assert.equal(state.previousLimitBytesPerSecond, 2 * MB)
  assert.equal(state.expiresAt, f.now() + 15 * 60_000)
  f.jump(15 * 60_000)
  await f.fireTimer()
  assert.equal(f.engine.limit, 2 * MB)
  assert.equal(controller.getSnapshot().status, 'inactive')
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.writes().map(call => call.bandwidthLimitBytesPerSecond), [5 * MB, 2 * MB])
})

test('restart while disconnected performs no writes until a verified engine read is available', async () => {
  const f = fixture(); const first = f.create(); await first.apply(MB, 15); await first.stop()
  f.jump(20 * 60_000); f.engine.status = 'connecting'
  const restarted = f.create(); await restarted.start()
  assert.equal(restarted.getSnapshot().status, 'restoring')
  assert.equal(f.writes().length, 1)
  await f.fireTimer(); assert.equal(f.writes().length, 1)
  f.engine.status = 'live'; await restarted.reconcile()
  assert.equal(f.engine.limit, 0)
  assert.equal(restarted.getSnapshot().status, 'inactive')
})

test('an observed external limit change permanently relinquishes the old restore plan', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.engine.limit = 7 * MB
  await controller.reconcile()
  assert.equal(controller.getSnapshot().status, 'inactive')
  f.jump(30 * 60_000); await controller.reconcile()
  assert.equal(f.engine.limit, 7 * MB)
  assert.equal(f.writes().length, 1)
  assert.equal(JSON.parse(f.contents()).lease, null)
})

test('observed external ownership stays relinquished when cancellation persistence fails', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.engine.limit = 7 * MB; f.storage.fail = true
  await controller.reconcile()
  assert.equal(controller.getSnapshot().status, 'inactive')
  assert.match(controller.getSnapshot().error, /保存/)
  f.engine.limit = MB; f.jump(30 * 60_000); await f.fireTimer()
  assert.equal(f.engine.limit, MB); assert.equal(f.writes().length, 1)
  f.storage.fail = false; f.engine.status = 'down'; await f.fireTimer()
  assert.equal(JSON.parse(f.contents()).lease, null)
  assert.equal(f.timers.size, 0)
  await controller.stop(); f.engine.status = 'live'
  await f.create().start(); assert.equal(f.engine.limit, MB)
})

test('a failed new request cannot resurrect ownership relinquished by its fresh engine read', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.engine.limit = 7 * MB; f.storage.fail = true
  await assert.rejects(controller.apply(5 * MB, 30), /保存/)
  f.engine.limit = MB; f.storage.fail = false; f.jump(30 * 60_000)
  await controller.reconcile()
  assert.equal(f.engine.limit, MB); assert.equal(f.writes().length, 1)
})

test('transient recovery-record read failure retries and blocks overwriting unknown state', async () => {
  const f = fixture({ limit: 2 * MB }); const first = f.create(); await first.apply(MB, 15); await first.stop()
  f.jump(16 * 60_000); f.storage.failRead = true
  const restarted = f.create(); await restarted.start()
  assert.match(restarted.getSnapshot().error, /读取/)
  assert.equal(f.timers.size, 1)
  const stored = f.contents(); const writes = f.writes().length
  await assert.rejects(restarted.apply(5 * MB, 30), /读取/)
  assert.equal(f.contents(), stored); assert.equal(f.writes().length, writes)
  f.storage.failRead = false; await f.fireTimer()
  assert.equal(f.engine.limit, 2 * MB)
  assert.equal(restarted.getSnapshot().status, 'inactive')
  assert.equal(restarted.getSnapshot().error, undefined)
})

test('manual same-value writes cancel expiry and unrelated settings retain it', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  await controller.updateSettings({ maxConnections: 8 })
  assert.equal(controller.getSnapshot().status, 'active')
  await controller.updateSettings({ bandwidthLimitBytesPerSecond: MB })
  f.jump(30 * 60_000); await controller.reconcile()
  assert.equal(f.engine.limit, MB)
  assert.equal(controller.getSnapshot().status, 'inactive')
})

test('latest manual action follows an in-flight temporary write and wins at expiry', async () => {
  const f = fixture(); const controller = f.create(); const gate = deferred(); let first = true
  f.engine.write = async extra => { if (first) { first = false; await gate.promise }; f.engine.limit = extra.bandwidthLimitBytesPerSecond; return { ok: true } }
  const apply = controller.apply(MB, 15); await flush()
  const manual = controller.updateSettings({ bandwidthLimitBytesPerSecond: 9 * MB })
  assert.equal(f.writes().length, 1)
  gate.resolve(); await Promise.all([apply, manual]); f.jump(30 * 60_000); await controller.reconcile()
  assert.equal(f.engine.limit, 9 * MB)
  assert.deepEqual(f.writes().map(call => call.bandwidthLimitBytesPerSecond), [MB, 9 * MB])
})

test('missing acknowledgements and malformed engine reads never count as success', async () => {
  for (const reply of [{ settings: { bandwidthLimitBytesPerSecond: 0 } }, { ok: false }, { ok: true }, { ok: true, settings: { bandwidthLimitBytesPerSecond: '0' } }]) {
    const f = fixture(); f.engine.read = async () => reply; const controller = f.create()
    await assert.rejects(controller.apply(MB, 15))
    assert.equal(f.writes().length, 0)
  }
  for (const reply of [{}, { ok: false }, { ok: true, settings: { bandwidthLimitBytesPerSecond: 123 } }]) {
    const f = fixture(); f.engine.write = async () => reply; const controller = f.create()
    await assert.rejects(controller.apply(MB, 15))
    assert.notEqual(controller.getSnapshot().status, 'active')
    f.engine.write = null; await controller.apply(MB, 15)
    assert.equal(controller.getSnapshot().status, 'active')
  }
})

test('a lost write acknowledgement keeps a recoverable record across restart', async () => {
  const f = fixture({ limit: 3 * MB }); const first = f.create()
  f.engine.write = async extra => { f.engine.limit = extra.bandwidthLimitBytesPerSecond; throw new Error('timeout') }
  await assert.rejects(first.apply(MB, 15), /timeout/)
  assert.equal(JSON.parse(f.contents()).lease.acknowledged, false)
  await first.stop(); f.engine.write = null
  const restarted = f.create(); await restarted.start()
  assert.equal(restarted.getSnapshot().status, 'checking')
  f.jump(16 * 60_000); await restarted.reconcile()
  assert.equal(f.engine.limit, 3 * MB)
  assert.equal(restarted.getSnapshot().status, 'inactive')
})

test('failed replacement recovers the prior lease and its original deadline', async () => {
  const f = fixture(); const first = f.create(); const original = await first.apply(MB, 15)
  f.jump(60_000); f.engine.write = async () => { throw new Error('not dispatched') }
  await assert.rejects(first.apply(5 * MB, 60)); await first.stop(); f.engine.write = null
  const restarted = f.create(); await restarted.start()
  assert.equal(restarted.getSnapshot().expiresAt, original.expiresAt)
  assert.equal(restarted.getSnapshot().limitBytesPerSecond, MB)
  f.jump(15 * 60_000); await restarted.reconcile(); assert.equal(f.engine.limit, 0)
})

test('a verified fallback remains the only owner when narrowing its recovery record fails', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.engine.write = async () => { throw new Error('not dispatched') }
  await assert.rejects(controller.apply(5 * MB, 60)); f.engine.write = null
  f.storage.fail = true; await controller.reconcile()
  assert.equal(controller.getSnapshot().limitBytesPerSecond, MB)
  f.engine.limit = 5 * MB; f.storage.fail = false; f.jump(61 * 60_000)
  const writes = f.writes().length; await controller.reconcile()
  assert.equal(f.engine.limit, 5 * MB); assert.equal(f.writes().length, writes)
  assert.equal(controller.getSnapshot().status, 'inactive')
})

test('replacing or extending a live lease keeps the original baseline', async () => {
  const f = fixture({ limit: 2 * MB }); const controller = f.create(); await controller.apply(MB, 15)
  f.jump(60_000); await controller.apply(5 * MB, 30)
  const writesBeforeExtension = f.writes().length
  const extended = await controller.apply(5 * MB, 60)
  assert.equal(f.writes().length, writesBeforeExtension)
  assert.equal(extended.previousLimitBytesPerSecond, 2 * MB)
  f.jump(61 * 60_000); await controller.reconcile(); assert.equal(f.engine.limit, 2 * MB)
})

test('recovery storage must be saved before changing an engine setting', async () => {
  const f = fixture(); const controller = f.create(); f.storage.fail = true
  await assert.rejects(controller.apply(MB, 15), /保存/)
  assert.equal(f.writes().length, 0)
  f.storage.fail = false; await controller.apply(MB, 15)
  f.storage.fail = true
  await assert.rejects(controller.updateSettings({ bandwidthLimitBytesPerSecond: 8 * MB }), /保存/)
  assert.equal(f.engine.limit, MB)
})

test('failure to persist an acknowledged write still leaves a recoverable pending journal', async () => {
  const f = fixture({ limit: 2 * MB }); const first = f.create()
  f.engine.write = async extra => {
    f.engine.limit = extra.bandwidthLimitBytesPerSecond
    f.storage.fail = true
    return { ok: true }
  }
  await assert.rejects(first.apply(MB, 15), /保存/)
  assert.equal(f.engine.limit, MB)
  assert.equal(JSON.parse(f.contents()).lease.acknowledged, false)
  await first.stop(); f.storage.fail = false; f.engine.write = null
  f.jump(16 * 60_000)
  const restarted = f.create(); await restarted.start()
  assert.equal(f.engine.limit, 2 * MB)
})

test('failed restore retries using a fresh read and respects a later external change', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.jump(16 * 60_000); f.engine.write = async () => { throw new Error('temporary failure') }
  await controller.reconcile()
  assert.equal(controller.getSnapshot().status, 'restoring')
  const writesAfterFailure = f.writes().length
  f.engine.limit = 7 * MB; f.engine.write = null
  await f.fireTimer()
  assert.equal(f.engine.limit, 7 * MB)
  assert.equal(f.writes().length, writesAfterFailure)
  assert.equal(controller.getSnapshot().status, 'inactive')
})

test('an acknowledged restore ends ownership even when its cancellation record cannot be saved', async () => {
  const f = fixture(); const controller = f.create(); await controller.apply(MB, 15)
  f.engine.write = async extra => { f.engine.limit = extra.bandwidthLimitBytesPerSecond; f.storage.fail = true; return { ok: true } }
  f.jump(16 * 60_000); await controller.reconcile()
  assert.equal(f.engine.limit, 0); assert.equal(controller.getSnapshot().status, 'inactive')
  f.engine.limit = MB; f.storage.fail = false; f.engine.write = null
  const writes = f.writes().length; await f.fireTimer()
  assert.equal(f.engine.limit, MB); assert.equal(f.writes().length, writes)
  assert.equal(JSON.parse(f.contents()).lease, null)
})

test('restore-now remains retryable across engine failure and subsequent reconnect', async () => {
  const f = fixture({ limit: 2 * MB }); const controller = f.create(); await controller.apply(MB, 60)
  f.engine.write = async () => { throw new Error('disconnected') }
  await assert.rejects(controller.restoreNow())
  assert.equal(controller.getSnapshot().status, 'restoring')
  f.engine.write = null; await controller.reconcile(); assert.equal(f.engine.limit, 2 * MB)
})

test('restore-now requested offline restores on reconnect instead of waiting for the original deadline', async () => {
  const f = fixture({ limit: 2 * MB }); const first = f.create(); await first.apply(MB, 60)
  f.engine.status = 'connecting'
  await assert.rejects(first.restoreNow(), /连接/)
  assert.equal(first.getSnapshot().status, 'restoring')
  await first.stop(); f.jump(60_000); f.engine.status = 'live'
  const restarted = f.create(); await restarted.start()
  assert.equal(f.engine.limit, 2 * MB)
})

test('uncertain manual takeover is durably disarmed before retry or restart', async () => {
  const f = fixture(); const first = f.create(); await first.apply(MB, 15)
  f.engine.write = async extra => { f.engine.limit = extra.bandwidthLimitBytesPerSecond; throw new Error('lost ack') }
  await assert.rejects(first.updateSettings({ bandwidthLimitBytesPerSecond: 4 * MB })); await first.stop()
  f.jump(30 * 60_000); f.engine.write = null; const restarted = f.create(); await restarted.start()
  assert.equal(f.engine.limit, 4 * MB)
  assert.equal(restarted.getSnapshot().status, 'inactive')
})

test('stop cancels recovery and prevents a pending read from dispatching a setting write', async () => {
  const f = fixture(); const controller = f.create(); const gate = deferred()
  f.engine.read = () => gate.promise
  const apply = controller.apply(MB, 15); await flush(); const stop = controller.stop()
  gate.resolve({ ok: true, settings: { bandwidthLimitBytesPerSecond: 0 } })
  await assert.rejects(apply, /停止/); await stop
  assert.equal(f.writes().length, 0); assert.equal(f.timers.size, 0)
})

test('invalid duration or limit is rejected before reaching engine or storage', async () => {
  const f = fixture(); const controller = f.create()
  for (const [limit, minutes] of [[0, 15], [-1, 15], [NaN, 15], [Infinity, 15], [1.5, 15], [MB, 10], [MB, '15']]) await assert.rejects(controller.apply(limit, minutes))
  assert.equal(f.engine.calls.length, 0); assert.equal(f.contents(), null)
})

test('file-backed recovery is atomic, isolated, and refuses corrupt state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ndm-temporary-bandwidth-'))
  try {
    const f = fixture()
    const path = temporaryBandwidthStatePath('/must-not-write-real-user-data', directory)
    const first = new TemporaryBandwidthController({ engine: f.engine, statePath: path, clock: f.clock })
    await first.apply(MB, 15); await first.stop()
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).lease.acknowledged, true)
    assert.deepEqual(readdirSync(directory), ['temporary-bandwidth.json'])
    f.jump(16 * 60_000)
    const restarted = new TemporaryBandwidthController({ engine: f.engine, statePath: path, clock: f.clock })
    await restarted.start(); assert.equal(f.engine.limit, 0); await restarted.stop()
    writeFileSync(path, '{broken')
    f.engine.limit = 7 * MB; const writes = f.writes().length
    const corrupt = new TemporaryBandwidthController({ engine: f.engine, statePath: path, clock: f.clock })
    await corrupt.start()
    assert.match(corrupt.getSnapshot().error, /无法读取/)
    assert.equal(f.writes().length, writes); assert.equal(f.engine.limit, 7 * MB)
    await corrupt.stop()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
