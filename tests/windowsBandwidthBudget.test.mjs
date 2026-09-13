import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateWindowsBandwidth, WindowsBandwidthBudget } from '../src/main/windows/bandwidthBudget.ts'

test('two active download engines share one total budget; a single engine receives the full limit', () => {
  assert.deepEqual(allocateWindowsBandwidth(1025, { primary: true, auxiliary: true }), { primary: 513, auxiliary: 512 })
  assert.deepEqual(allocateWindowsBandwidth(1025, { primary: true, auxiliary: false }), { primary: 1025, auxiliary: 1025 })
  assert.deepEqual(allocateWindowsBandwidth(0, { primary: true, auxiliary: true }), { primary: 0, auxiliary: 0 })
  assert.throws(() => allocateWindowsBandwidth(1, { primary: true, auxiliary: true }), /至少/)
  assert.deepEqual(allocateWindowsBandwidth(1, { primary: true, auxiliary: false }), { primary: 1, auxiliary: 1 })
})

test('budget handoff lowers the first engine before increasing the newly active engine', async () => {
  const caps = { primary: 1000, auxiliary: 100 }, writes = []
  const budget = new WindowsBandwidthBudget({ readCap: async engine => caps[engine], writeCap: async (engine, value) => { writes.push([engine, value]); caps[engine] = value } })
  assert.deepEqual(await budget.reconcile(1000, { primary: true, auxiliary: true }), { primary: 500, auxiliary: 500 })
  assert.deepEqual(writes, [['primary', 500], ['auxiliary', 500]])
})

test('a failed decrease prevents all subsequent increases; retry reads a lost-ACK change afresh', async () => {
  const caps = { primary: 1000, auxiliary: 100 }, writes = []
  let fail = true
  const budget = new WindowsBandwidthBudget({ readCap: async engine => caps[engine], writeCap: async (engine, value) => {
    writes.push([engine, value]); caps[engine] = value
    if (fail) { fail = false; throw new Error('lost ACK') }
  } })
  await assert.rejects(budget.reconcile(1000, { primary: true, auxiliary: true }), /lost ACK/)
  assert.deepEqual(writes, [['primary', 500]])
  await budget.reconcile(1000, { primary: true, auxiliary: true })
  assert.deepEqual(writes, [['primary', 500], ['auxiliary', 500]])
})

test('a successful RPC response without readback agreement does not approve a new total limit', async () => {
  const budget = new WindowsBandwidthBudget({ readCap: async () => 0, writeCap: async () => undefined })
  await assert.rejects(budget.reconcile(1024, { primary: true, auxiliary: true }), /尚未确认/)
})

test('unstarted auxiliary child is not launched by a read and receives a safe startup allocation', async () => {
  let cap = 4096
  const writes = []
  const budget = new WindowsBandwidthBudget({ readCap: async engine => engine === 'primary' ? cap : null, writeCap: async (engine, value) => { writes.push(engine); cap = value } })
  const plan = await budget.reconcile(4096, { primary: true, auxiliary: true })
  assert.equal(plan.auxiliary, 2048); assert.equal(cap, 2048); assert.deepEqual(writes, ['primary'])
})

test('concurrent manual limit changes finish in order and later failures do not corrupt the serialized queue', async () => {
  const caps = { primary: 0, auxiliary: 0 }, writes = []
  const budget = new WindowsBandwidthBudget({ readCap: async engine => caps[engine], writeCap: async (engine, value) => {
    await new Promise(resolve => setImmediate(resolve)); writes.push([engine, value]); caps[engine] = value
  } })
  const demand = { primary: true, auxiliary: true }
  await Promise.all([budget.reconcile(2048, demand), budget.reconcile(4096, demand)])
  assert.deepEqual(caps, { primary: 2048, auxiliary: 2048 })
  assert.deepEqual(writes, [['primary', 1024], ['auxiliary', 1024], ['primary', 2048], ['auxiliary', 2048]])
})
