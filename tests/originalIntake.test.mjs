import { test } from 'node:test'
// Exercise POSIX-only research contracts on POSIX; Windows tests the explicit guard.
const posixTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OriginalIntake } from '../src/main/original/intake.ts'

async function fixture(t, accept = true) {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-intake-test-'))
  const rows = [], messages = [], sockets = new Set()
  let connections = 0
  const server = createServer()
  server.on('upgrade', (request, socket) => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    const hash = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\nSec-WebSocket-Protocol: neatextension.v1\r\n\r\n`)
    let buffer = Buffer.alloc(0)
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 2) {
        let size = buffer[1] & 127, offset = 2
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4 }
        if (buffer.length < offset + 4 + size) return
        const mask = buffer.subarray(offset, offset + 4), body = buffer.subarray(offset + 4, offset + 4 + size)
        const op = buffer[0] & 15
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        buffer = buffer.subarray(offset + 4 + size)
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return }
        const payload = body.toString('utf8')
        messages.push({ payload, time: performance.now() })
        if (accept) rows.push({ id: rows.length + 1, url: /^2:(.*)$/m.exec(payload)[1].trim(), method: /^1:(.*)$/m.exec(payload)[1].trim() })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const clients = []
  const client = (timeout = 1000) => {
    const result = new OriginalIntake(directory, server.address().port, async () => rows.slice(), timeout)
    clients.push(result); return result
  }
  t.after(async () => {
    for (const item of clients) await item.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, rows, messages, client, connections: () => connections }
}
posixTest('desktop intake serializes and spaces original submissions on one connection', async t => {
  const f = await fixture(t), client = f.client()
  const first = { key: 'one', url: 'https://example.test/a' }
  assert.deepEqual(await Promise.all([client.submit(first), client.submit({ key: 'two', url: 'https://example.test/b', method: 'POST', body: 'a=1', contentType: 'application/x-www-form-urlencoded' })]), [1, 2])
  assert.equal(f.connections(), 1)
  assert.ok(f.messages[1].time - f.messages[0].time >= 500)
  assert.match(f.messages[1].payload, /Content-Type: application\/x-www-form-urlencoded\r\n__0NeatPostData9__:a=1$/)
  assert.equal(await client.submit(first), 1)
  assert.equal(f.messages.length, 2)
  await assert.rejects(client.submit({ ...first, url: 'https://example.test/different' }), /different content/)
})
posixTest('pending GET survives a new client and is reconciled without resending', async t => {
  const f = await fixture(t, false), first = f.client(100)
  const request = { key: 'uncertain', url: 'https://example.test/a' }
  await assert.rejects(first.submit(request), /outcome unknown/)
  const journal = JSON.parse(await readFile(join(f.directory, 'desktop-receipts.json'), 'utf8'))
  assert.equal(journal.receipts.uncertain.taskID, undefined)
  await first.close()
  f.rows.push({ id: 7, url: request.url, method: 'GET' })
  assert.equal(await f.client().submit(request), 7)
  assert.equal(f.messages.length, 1)
})
posixTest('uncertain POST is not recovered by URL alone and blocks further submissions', async t => {
  const f = await fixture(t, false), first = f.client(100)
  const request = { key: 'post', url: 'https://example.test/export', method: 'POST', body: 'private-body' }
  await assert.rejects(first.submit(request), /outcome unknown/)
  await first.close()
  f.rows.push({ id: 9, url: request.url, method: 'POST' })
  const second = f.client()
  await assert.rejects(second.submit(request), /POST submission outcome unknown/)
  await assert.rejects(second.submit({ key: 'another', url: 'https://example.test/a' }), /Resolve pending/)
  assert.equal(f.messages.length, 1)
  assert.ok(!(await readFile(join(f.directory, 'desktop-receipts.json'), 'utf8')).includes('private-body'))
})

test('Windows rejects POSIX research adapter before side effects', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-original-platform-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const intake = new OriginalIntake(directory, 12345, async () => { throw new Error('Must not inspect tasks') })
  await assert.rejects(intake.submit({ key: 'one', url: 'https://example.test/file' }), /requires POSIX/)
  await intake.close()
  assert.deepEqual(await readdir(directory), [])
})
