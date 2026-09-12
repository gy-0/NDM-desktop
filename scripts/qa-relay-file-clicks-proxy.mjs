// Owned fault proxy. Pass all bytes unchanged except the explicitly selected
// receipt drop, or one request rejected before any byte reaches the real host.
import { createServer, createConnection } from 'node:net'

function encoder(text) {
  const payload = Buffer.from(text), header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x81; header[1] = payload.length < 126 ? payload.length : 126
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}
function parser(forward, inspect, fail) {
  let buffer = Buffer.alloc(0), handshake = false
  return data => {
    buffer = Buffer.concat([buffer, data])
    if (!handshake) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      forward(buffer.subarray(0, end + 4)); buffer = buffer.subarray(end + 4); handshake = true
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = Boolean(buffer[1] & 128)
      let length = buffer[1] & 127, offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
      if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      if (length > 16 * 1024 * 1024) { fail(); return }
      const maskOffset = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      const frame = buffer.subarray(0, offset + length); buffer = buffer.subarray(offset + length)
      const payload = Buffer.from(frame.subarray(offset))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= frame[maskOffset + i % 4]
      const text = opcode === 1 ? payload.toString('utf8') : ''
      if (inspect(text) !== false) forward(frame)
    }
  }
}
export async function createBridgeFaultProxy(upstreamPort, record, mode = 'drop-ack') {
  const sockets = new Set()
  let faultUsed = false
  const server = createServer(client => {
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort })
    sockets.add(client); sockets.add(upstream)
    const close = () => { upstream.destroy(); client.destroy() }
    if (mode === 'reject-first') client.on('data', parser(data => upstream.write(data), text => {
      if (!faultUsed && text.startsWith('NDMRelayDownload:')) {
        const request = JSON.parse(text.slice('NDMRelayDownload:'.length))
        faultUsed = true
        const receipt = { requestId: request.requestId, status: 'rejected', error: 'synthetic-qa-first-rejection' }
        record('proxy:request-rejected-before-native', receipt)
        client.write(encoder('NDMRelayReceipt:' + JSON.stringify(receipt)))
        return false
      }
    }, close))
    else client.on('data', data => upstream.write(data))
    upstream.on('data', parser(data => client.write(data), text => {
      if (text.startsWith('NDMRelayReceipt:')) {
        const receipt = JSON.parse(text.slice('NDMRelayReceipt:'.length))
        if (!faultUsed && mode === 'drop-ack') { faultUsed = true; record('proxy:receipt-dropped', receipt); return false }
        record('proxy:receipt-forwarded', receipt)
      }
    }, close))
    client.on('error', close); upstream.on('error', close)
    client.on('close', () => { sockets.delete(client); upstream.destroy() })
    upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  if ([51873, 51874, 10007].includes(server.address().port)) { await new Promise(done => server.close(done)); return createBridgeFaultProxy(upstreamPort, record, mode) }
  return { port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)) } }
}
