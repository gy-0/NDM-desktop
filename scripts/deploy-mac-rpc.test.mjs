import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createDeployRPC } from './deploy-mac-rpc.mjs'

test('unmatched continuous broadcasts do not extend the absolute RPC deadline', async () => {
  let sent = 0
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    const timer = setInterval(() => { sent++; socket.write('{"id":-1,"op":"snapshot","tasks":[]}\n') }, 5)
    socket.on('error', () => {})
    socket.on('close', () => { clearInterval(timer); sockets.delete(socket) })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const rpc = createDeployRPC({ port: server.address().port })
    const started = Date.now()
    await assert.rejects(rpc('pause', { taskID: 1 }, 80), /Engine pause timed out/)
    assert.ok(sent >= 2, 'The socket must receive traffic while waiting for the missing ACK')
    assert.ok(Date.now() - started < 1000, 'Continuous traffic cannot keep request alive')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(done => server.close(done))
  }
})

test('only matching ID completes RPC while unrelated snapshot is ignored', async () => {
  const server = createServer(socket => {
    socket.on('data', data => {
      const request = JSON.parse(data.toString())
      socket.write('{"id":-1,"ok":true,"tasks":[]}\n')
      socket.end(JSON.stringify({ id: request.id, ok: true }) + '\n')
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const rpc = createDeployRPC({ port: server.address().port })
    assert.equal((await rpc('pause', { taskID: 1 }, 1000)).ok, true)
  } finally { await new Promise(done => server.close(done)) }
})
