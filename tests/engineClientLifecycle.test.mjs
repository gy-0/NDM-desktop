import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Compile the real client without bundling its Electron/Windows dependencies.
// createRequire keeps the compiler out of the runner's temporary test bundle.
const ts = createRequire(resolve('package.json'))('typescript')
const compiled = ts.transpileModule(readFileSync('src/main/engine.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function harness(t, { platform = 'darwin', binaryExists = true } = {}) {
  let now = 0
  let sequence = 0
  let focused = 0
  const timers = new Map()
  const sockets = []
  const children = []
  const events = []
  const windowsEngines = []
  const window = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    webContents: {
      destroyed: false,
      isDestroyed() { return this.destroyed },
      send(channel, payload) {
        assert.equal(this.destroyed, false, 'must not send to destroyed webContents')
        events.push([channel, JSON.parse(JSON.stringify(payload))])
      }
    }
  }
  const setTimeout = (callback, delay) => {
    const handle = { id: ++sequence }
    timers.set(handle, { callback, at: now + delay })
    return handle
  }
  const clearTimeout = (handle) => timers.delete(handle)
  const advance = (milliseconds) => {
    const until = now + milliseconds
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      const [handle, timer] = next
      now = timer.at
      timers.delete(handle)
      timer.callback()
    }
    now = until
  }
  class Socket extends EventEmitter {
    destroyed = false
    sent = []
    writeError = null
    callbackError = null
    setEncoding(encoding) { assert.equal(encoding, 'utf8') }
    write(frame, callback) {
      if (this.writeError) throw this.writeError
      this.sent.push(JSON.parse(frame))
      callback?.(this.callbackError)
      return true
    }
    destroy() { this.destroyed = true }
    reply(request = this.sent.at(-1), extra = {}) {
      this.emit('data', JSON.stringify({ id: request.id, ok: true, ...extra }) + '\n')
    }
  }
  class Child extends EventEmitter {
    killed = false
    killCalls = 0
    stdout = { drained: false, resume() { this.drained = true } }
    stderr = new EventEmitter()
    kill() {
      this.killed = true
      this.killCalls += 1
      // Exit is deliberately separate: sending SIGTERM is not process exit.
      return true
    }
  }
  class WindowsEngine {
    starts = 0
    stops = 0
    calls = []
    constructor(_options, callbacks) {
      this.callbacks = callbacks
      windowsEngines.push(this)
    }
    async start() { this.starts += 1; this.callbacks.onStatus('live') }
    async stop() { this.stops += 1 }
    async request(op, extra) { this.calls.push([op, extra]); return { ok: true } }
  }
  const dependencies = {
    'node:child_process': { spawn: () => { const child = new Child(); children.push(child); return child } },
    'node:fs': { existsSync: () => binaryExists },
    'node:path': { join },
    'node:net': { createConnection: (options) => {
      assert.equal(options.host, '127.0.0.1')
      const socket = new Socket()
      sockets.push(socket)
      return socket
    } },
    electron: {
      app: { getAppPath: () => '/app', getPath: () => '/data', isPackaged: false },
      BrowserWindow: { getAllWindows: () => [window] },
      shell: { trashItem: async () => {} }
    },
    './browserCookies': { exportCookieHeader: async () => ({}) },
    './windows/windowsEngine': { WindowsDownloadEngine: WindowsEngine }
  }
  const module = { exports: {} }
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
      return dependencies[name]
    },
    process: { platform, resourcesPath: '/resources', env: {}, cwd: () => '/app', stderr: { write() {} } },
    console: { warn() {} },
    setTimeout,
    clearTimeout
  }, { filename: 'engine.cjs' })
  const client = new module.exports.EngineClient(() => { focused += 1 })
  t.after(() => client.stop())
  const connect = ({ acknowledge = true, tasks = [] } = {}) => {
    const socket = sockets.at(-1)
    socket.emit('connect')
    if (acknowledge) socket.reply(socket.sent.at(-1), { tasks })
    return socket
  }
  const disconnect = (socket = sockets.at(-1), code = 'ECONNREFUSED') => {
    socket.emit('error', Object.assign(new Error(code), { code }))
    socket.destroy()
    socket.emit('close')
  }
  return {
    client, sockets, children, events, window, windowsEngines, connect, disconnect, advance,
    get timerCount() { return timers.size },
    get focused() { return focused }
  }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('start and repeated manual retries share one connecting socket', (t) => {
  const h = harness(t)
  h.client.start()
  h.client.start()
  h.client.retry()
  h.client.retry()
  assert.equal(h.sockets.length, 1)
  assert.equal(h.timerCount, 1)
})

test('connecting to an existing host cancels the delayed spawn and bootstraps tasks', async (t) => {
  const h = harness(t)
  h.client.start()
  h.connect({ tasks: [{ id: 7 }] })
  await flush()
  h.advance(1000)
  assert.equal(h.children.length, 0)
  assert.equal(h.timerCount, 0)
  assert.equal(h.client.status, 'live')
  assert.deepEqual(h.events.at(-1), ['engine:event', { op: 'snapshot', tasks: [{ id: 7 }] }])
})

test('stop cancels a connecting socket and ignores its late connect event', async (t) => {
  const h = harness(t)
  h.client.start()
  const socket = h.sockets[0]
  h.client.stop()
  assert.equal(socket.destroyed, true)
  assert.equal(h.timerCount, 0)
  socket.emit('connect')
  socket.emit('data', '{"op":"focusApp"}\n')
  socket.emit('close')
  h.client.retry()
  h.client.start()
  h.advance(5000)
  assert.equal(h.sockets.length, 1)
  assert.equal(h.children.length, 0)
  assert.equal(h.focused, 0)
  assert.notEqual(h.client.status, 'live')
  await assert.rejects(h.client.request('list'), /引擎已停止/)
})

test('manual retry consumes the scheduled retry instead of creating another retry loop', (t) => {
  const h = harness(t)
  h.client.start()
  h.disconnect()
  h.advance(250)
  h.client.retry()
  h.advance(5000)
  assert.equal(h.sockets.length, 2)
  assert.equal(h.children.length, 1)
  assert.equal(h.timerCount, 0)
})

test('automatic retries preserve bounded backoff and eventually surface down', (t) => {
  const h = harness(t)
  h.client.start()
  for (let attempt = 1; attempt <= 22; attempt += 1) {
    h.disconnect()
    assert.equal(h.client.status, attempt > 20 ? 'down' : 'connecting')
    assert.match(h.client.engineError, /ECONNREFUSED/)
    const count = h.sockets.length
    const delay = Math.min(2000, 400 + attempt * 80)
    h.advance(delay - 1)
    assert.equal(h.sockets.length, count)
    h.advance(1)
    assert.equal(h.sockets.length, count + 1)
  }
  h.connect()
  assert.equal(h.client.engineError, undefined)
})

test('a truncated frame from a dead socket cannot corrupt the new connection', (t) => {
  const h = harness(t)
  h.client.start()
  const old = h.connect()
  old.emit('data', '{"op":"focus')
  h.disconnect(old)
  h.client.retry()
  const current = h.connect({ acknowledge: false })
  current.emit('data', '{"op":"focusApp"}\n')
  assert.equal(h.focused, 1)
})

test('fragmented and coalesced JSON frames are each dispatched exactly once', (t) => {
  const h = harness(t)
  h.client.start()
  const socket = h.connect()
  const frame = '{"op":"snapshot","tasks":[{"id":8,"title":"测试"}]}\n'
  socket.emit('data', frame.slice(0, 13))
  socket.emit('data', frame.slice(13) + '\nnot-json\n{"op":"focusApp"}\n')
  assert.equal(h.focused, 1)
  assert.deepEqual(h.events.at(-1), ['engine:event', { op: 'snapshot', tasks: [{ id: 8, title: '测试' }] }])
})

test('late events from a replaced socket cannot demote the live connection or reject its requests', async (t) => {
  const h = harness(t)
  h.client.start()
  const old = h.connect()
  h.disconnect(old)
  h.client.retry()
  const current = h.connect()
  const request = h.client.request('ping')
  old.emit('connect')
  old.emit('error', new Error('late error'))
  old.emit('close')
  old.emit('data', '{"op":"focusApp"}\n')
  assert.equal(h.client.status, 'live')
  assert.equal(h.focused, 0)
  current.reply()
  assert.equal((await request).ok, true)
  h.advance(5000)
  assert.equal(h.sockets.length, 2)
})

test('a resolved bootstrap reply is ignored after its socket has been replaced', async (t) => {
  const h = harness(t)
  h.client.start()
  h.connect({ tasks: [{ id: 1 }] })
  h.disconnect()
  h.client.retry()
  h.connect({ tasks: [{ id: 2 }] })
  await flush()
  const snapshots = h.events.filter(([channel]) => channel === 'engine:event')
  assert.deepEqual(snapshots, [['engine:event', { op: 'snapshot', tasks: [{ id: 2 }] }]])
})

test('disconnect promptly rejects all pending requests and clears their deadlines', async (t) => {
  const h = harness(t)
  h.client.start()
  h.connect()
  const one = assert.rejects(h.client.request('ping'), /引擎连接已断开/)
  const two = assert.rejects(h.client.request('probeMedia'), /引擎连接已断开/)
  h.disconnect()
  await Promise.all([one, two])
  assert.equal(h.timerCount, 1, 'only the reconnect timer remains')
  h.client.stop()
  assert.equal(h.timerCount, 0)
})

test('stop rejects pending requests, disables new requests and clears all timers', async (t) => {
  const h = harness(t)
  h.client.start()
  const socket = h.connect()
  const pending = assert.rejects(h.client.request('probeMedia'), /引擎已停止/)
  h.client.stop()
  await pending
  await assert.rejects(h.client.request('list'), /引擎已停止/)
  assert.equal(socket.destroyed, true)
  assert.equal(h.timerCount, 0)
})

for (const [op, extra, timeout] of [
  ['ping', {}, 20_000],
  ['probeMedia', {}, 180_000],
  ['installDMG', {}, 180_000],
  ['fileArtwork', { path: '/tmp/test.DMG' }, 180_000],
  ['fileArtwork', { path: '/tmp/test.iso' }, 180_000],
  ['fileArtwork', { path: '/tmp/test.png' }, 20_000]
]) {
  test(`${op} ${extra.path ?? ''} retains its ${timeout}ms response deadline`, async (t) => {
    const h = harness(t)
    h.client.start()
    h.connect()
    let rejected = false
    const pending = assert.rejects(h.client.request(op, extra), /引擎响应超时/).then(() => { rejected = true })
    h.advance(timeout - 1)
    await flush()
    assert.equal(rejected, false)
    h.advance(1)
    await pending
    assert.equal(h.timerCount, 0)
  })
}

test('caller payload cannot replace the request id or operation', async (t) => {
  const h = harness(t)
  h.client.start()
  const socket = h.connect()
  const pending = h.client.request('ping', { id: 9000, op: 'remove', taskID: 3 })
  const sent = socket.sent.at(-1)
  assert.equal(sent.op, 'ping')
  assert.notEqual(sent.id, 9000)
  assert.equal(sent.taskID, 3)
  socket.reply()
  assert.equal((await pending).ok, true)
})

test('serialization errors leave no pending request or timer', async (t) => {
  const h = harness(t)
  h.client.start()
  h.connect()
  const circular = {}
  circular.self = circular
  await assert.rejects(h.client.request('ping', circular), /circular/i)
  assert.equal(h.timerCount, 0)
})

for (const mode of ['writeError', 'callbackError']) {
  test(`${mode} rejects the request and releases its deadline immediately`, async (t) => {
    const h = harness(t)
    h.client.start()
    const socket = h.connect()
    socket[mode] = new Error('write failed')
    await assert.rejects(h.client.request('ping'), /write failed/)
    assert.equal(h.timerCount, 0)
  })
}

test('engine errors retain their errorKind and do not consume unrelated requests', async (t) => {
  const h = harness(t)
  h.client.start()
  const socket = h.connect()
  const pending = assert.rejects(h.client.request('probeMedia'), (error) => {
    assert.equal(error.message, 'session required')
    assert.equal(error.code, 'browserSessionRequired')
    return true
  })
  socket.reply({ id: 99999 })
  assert.equal(h.timerCount, 1)
  socket.reply(socket.sent.at(-1), { ok: false, error: 'session required', errorKind: 'browserSessionRequired' })
  await pending
  assert.equal(h.timerCount, 0)
})

test('an unreachable host is respawned only after its old process exits', (t) => {
  const h = harness(t)
  h.client.start()
  h.advance(250)
  const old = h.children[0]
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    h.disconnect()
    if (attempt < 10) h.advance(Math.min(2000, 400 + attempt * 80))
  }
  assert.equal(old.killCalls, 1)
  assert.equal(h.children.length, 1)
  old.emit('exit', 0)
  assert.equal(h.children.length, 2)
  h.advance(1200)
  h.connect()
  old.emit('exit', 0)
  assert.equal(h.client.status, 'live')
  h.client.stop()
  assert.equal(h.children[1].killCalls, 1)
})

test('stop cancels a host replacement waiting for process exit', (t) => {
  const h = harness(t)
  h.client.start()
  h.advance(250)
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    h.disconnect()
    if (attempt < 10) h.advance(Math.min(2000, 400 + attempt * 80))
  }
  h.client.stop()
  h.children[0].emit('exit', 0)
  h.advance(5000)
  assert.equal(h.children.length, 1)
  assert.equal(h.timerCount, 0)
})

test('late exit of a failed child cannot clear the replacement process', (t) => {
  const h = harness(t, { binaryExists: false })
  h.client.start()
  h.advance(250)
  const old = h.children[0]
  old.emit('error', new Error('spawn failed'))
  assert.match(h.client.engineError, /启动失败/)
  h.disconnect()
  h.client.retry()
  assert.equal(h.children.length, 2)
  old.emit('exit', 1)
  h.client.stop()
  assert.equal(h.children[1].killCalls, 1)
})

test('host stdout is drained so logging cannot fill its pipe', (t) => {
  const h = harness(t)
  h.client.start()
  h.advance(250)
  assert.equal(h.children[0].stdout.drained, true)
})

test('broadcasts skip destroyed windows and webContents', async (t) => {
  const h = harness(t)
  h.window.webContents.destroyed = true
  h.client.start()
  const socket = h.connect()
  socket.emit('data', '{"op":"snapshot","tasks":[]}\n')
  await flush()
  assert.equal(h.events.length, 0)
})

test('Windows keeps its in-process engine route without TCP or duplicate startup', async (t) => {
  const h = harness(t, { platform: 'win32' })
  h.client.start()
  h.client.start()
  h.client.retry()
  assert.equal(h.windowsEngines.length, 1)
  assert.equal(h.windowsEngines[0].starts, 1)
  assert.equal(h.sockets.length, 0)
  assert.equal(h.timerCount, 0)
  assert.equal((await h.client.request('ping')).ok, true)
  assert.equal(h.windowsEngines[0].calls[0][0], 'ping')
  h.client.stop()
  await assert.rejects(h.client.request('ping'), /引擎已停止/)
})
