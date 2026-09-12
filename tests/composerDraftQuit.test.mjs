import assert from 'node:assert/strict'
import test from 'node:test'
import { ComposerDraftQuitHandshake } from '../src/main/composerDraftQuit.ts'

function fixture() {
  const events = []
  const timers = new Map()
  let timerID = 0, tokenID = 0
  const state = { alive: true, draining: null, senderID: 12, onSend: null }
  const helper = new ComposerDraftQuitHandshake({
    getTarget: () => state.alive ? { id: state.senderID, send: token => { events.push(['send', token]); state.onSend?.(token) } } : null,
    drain: async () => { events.push(['drain']); await state.draining; events.push(['drained']) },
    onReady: () => events.push(['quit']),
    onCancel: () => events.push(['showMainWindow']),
    token: () => `token-${++tokenID}`,
    clock: {
      setTimer(callback, delay) { const id = ++timerID; timers.set(id, { callback, delay }); return id },
      clearTimer(id) { timers.delete(id) }
    }
  })
  return { helper, events, state, timers, async sent() { await Promise.resolve(); return events.findLast(([name]) => name === 'send')?.[1] },
    expire() { for (const { callback } of [...timers.values()]) callback() } }
}

test('a successful renderer ACK is required before draining and a second quit', async () => {
  const f = fixture()
  let release
  f.state.draining = new Promise(resolve => { release = resolve })
  const pending = f.helper.begin()
  const token = await f.sent()
  assert.equal(f.helper.ready, false)
  assert.deepEqual(f.events, [['send', token]])
  assert.equal([...f.timers.values()][0].delay, 5000)
  assert.equal(f.helper.acknowledge(12, token, true), true)
  await Promise.resolve()
  assert.deepEqual(f.events, [['send', token], ['drain']])
  assert.equal(f.helper.ready, false)
  release()
  assert.equal(await pending, true)
  assert.deepEqual(f.events, [['send', token], ['drain'], ['drained'], ['quit']])
  assert.equal(f.helper.ready, true)
  assert.equal(f.timers.size, 0)
})

test('ACK listener exists before broadcast, including a synchronous renderer reply', async () => {
  const f = fixture()
  f.state.onSend = token => assert.equal(f.helper.acknowledge(12, token, true), true)
  assert.equal(await f.helper.begin(), true)
  assert.equal(f.events.filter(([name]) => name === 'quit').length, 1)
  assert.equal(f.timers.size, 0)
})

test('a failed save cancels quit without closing storage or engine, and the next attempt can succeed', async () => {
  const f = fixture()
  const first = f.helper.begin()
  const firstToken = await f.sent()
  assert.equal(f.helper.acknowledge(12, firstToken, false), true)
  assert.equal(await first, false)
  assert.equal(f.helper.ready, false)
  assert.deepEqual(f.events, [['send', firstToken], ['showMainWindow']])
  const second = f.helper.begin()
  const secondToken = await f.sent()
  assert.notEqual(secondToken, firstToken)
  assert.equal(f.helper.acknowledge(12, secondToken, true), true)
  assert.equal(await second, true)
  assert.equal(f.events.filter(([name]) => name === 'drain').length, 1)
})

test('timeout is not a saved ACK; late replies cannot confirm a fresh quit attempt', async () => {
  const f = fixture()
  const first = f.helper.begin()
  const firstToken = await f.sent()
  f.expire()
  assert.equal(await first, false)
  assert.deepEqual(f.events, [['send', firstToken], ['showMainWindow']])
  assert.equal(f.helper.acknowledge(12, firstToken, true), false)
  const second = f.helper.begin()
  const secondToken = await f.sent()
  assert.equal(f.helper.acknowledge(12, firstToken, true), false)
  assert.equal(f.helper.ready, false)
  f.helper.acknowledge(12, secondToken, true)
  assert.equal(await second, true)
})

test('repeated quit shares one token, one drain and one final quit', async () => {
  const f = fixture()
  const first = f.helper.begin()
  const second = f.helper.begin()
  assert.equal(first, second)
  const token = await f.sent()
  const third = f.helper.begin()
  assert.equal(first, third)
  assert.equal(f.events.filter(([name]) => name === 'send').length, 1)
  f.helper.acknowledge(12, token, true)
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true])
  assert.equal(await f.helper.begin(), true)
  assert.equal(f.events.filter(([name]) => name === 'drain').length, 1)
  assert.equal(f.events.filter(([name]) => name === 'quit').length, 1)
})

test('wrong tokens, other renderers, and malformed boolean results cannot acknowledge a flush', async () => {
  const f = fixture()
  const pending = f.helper.begin()
  const token = await f.sent()
  assert.equal(f.helper.acknowledge(99, token, true), false)
  assert.equal(f.helper.acknowledge(12, 'other-token', true), false)
  assert.equal(f.helper.acknowledge(12, token, 'true'), false)
  assert.deepEqual(f.events, [['send', token]])
  assert.equal(f.helper.acknowledge(12, token, true), true)
  assert.equal(f.helper.acknowledge(12, token, true), false)
  assert.equal(await pending, true)
})

test('no main renderer needs no flush, but existing persistence work must drain', async () => {
  const f = fixture()
  f.state.alive = false
  assert.equal(await f.helper.begin(), true)
  assert.deepEqual(f.events, [['drain'], ['drained'], ['quit']])
  assert.equal(f.timers.size, 0)
})

test('a renderer destroyed during flush leaves only the received writes to drain', async () => {
  const f = fixture()
  const pending = f.helper.begin()
  await f.sent()
  f.state.alive = false
  f.expire()
  assert.equal(await pending, true)
  assert.equal(f.events.some(([name]) => name === 'showMainWindow'), false)
  assert.equal(f.events.at(-1)[0], 'quit')
})

test('a send failure keeps a live window and storage available for retry', async () => {
  const f = fixture()
  f.state.onSend = () => { throw new Error('renderer channel failed') }
  assert.equal(await f.helper.begin(), false)
  assert.equal(f.helper.ready, false)
  assert.equal(f.timers.size, 0)
  assert.equal(f.events.some(([name]) => name === 'drain'), false)
  assert.equal(f.events.at(-1)[0], 'showMainWindow')
})
