import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRelayBridgeStatus, describeRelayStatus } from '../src/renderer/src/lib/relayStatus.ts'

const worker = (version) => ({ version, protocol: 1, role: 'worker' })
const describe = (bridge) => describeRelayStatus(parseRelayBridgeStatus({ bridge }))
const base = { available: true, connectedClients: 1, expectedRelayVersion: '1.4.4' }

test('legacy bridge and plain sockets are connected without claiming a verified version', () => {
  assert.equal(describe({ available: true, connectedClients: 1 }).label, '已连接 · 版本未确认')
  assert.equal(describe({ ...base, relayClients: [] }).verified, false)
  assert.equal(describe({ ...base, expectedRelayVersion: null, relayClients: [worker('1.4.4')] }).label, '已连接 · 版本未确认')
})

test('only matching worker handshakes confirm the expected running version', () => {
  assert.deepEqual(describe({ ...base, connectedClients: 3, relayClients: [worker('1.4.4'), worker('1.4.4')] }), {
    label: '已连接', verified: true, detail: null
  })
  assert.equal(describe({ ...base, relayClients: [worker('1.4.3')] }).label, '扩展需要更新')
  const mixed = describe({ ...base, connectedClients: 2, relayClients: [worker('1.4.4'), worker('1.4.3')] })
  assert.equal(mixed.label, '扩展需要更新')
  assert.match(mixed.detail, /不同版本/)
  assert.equal(mixed.verified, false)
})

test('malformed optional metadata and non-worker clients cannot confirm a version or break legacy availability', () => {
  for (const relayClients of [null, {}, [null], [{ ...worker('1.4.4'), role: 'popup' }], [{ ...worker('1.4.4'), protocol: 0 }], [{ ...worker('1.4.4'), protocol: 2 }]]) {
    assert.equal(describe({ ...base, relayClients }).label, '已连接 · 版本未确认')
  }
})

test('waiting, unavailable, checking and request failures remain distinct', () => {
  assert.equal(describe({ ...base, connectedClients: 0 }).label, '等待浏览器连接')
  assert.equal(describe({ ...base, available: false }).label, '桥接未就绪')
  assert.equal(describeRelayStatus(null).label, '正在检查…')
  assert.equal(describeRelayStatus(null, true).label, '状态暂不可用')
  for (const connectedClients of [-1, 0.5, NaN, '1']) assert.throws(() => describe({ ...base, connectedClients }))
})
