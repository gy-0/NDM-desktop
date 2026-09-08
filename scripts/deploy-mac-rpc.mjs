import { createConnection } from 'node:net'

export function createDeployRPC({ port = 51874, host = '127.0.0.1' } = {}) {
  let requestID = 948200
  return function rpc(op, fields = {}, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++requestID, socket = createConnection({ port, host })
      let buffer = '', settled = false
      const finish = (error, reply) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        socket.destroy(); error ? reject(error) : resolve(reply)
      }
      socket.setEncoding('utf8')
      // Absolute request deadline: unrelated snapshots must never extend it.
      const deadline = setTimeout(() => finish(new Error(`Engine ${op} timed out`)), timeout)
      socket.on('error', finish)
      socket.on('close', () => finish(new Error(`Engine disconnected before ${op} was acknowledged`)))
      socket.on('connect', () => socket.write(JSON.stringify({ ...fields, id, op }) + '\n'))
      socket.on('data', chunk => {
        buffer += chunk
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n')
          let message
          try { message = JSON.parse(buffer.slice(0, index)) }
          catch { finish(new Error('Invalid engine response')); return }
          buffer = buffer.slice(index + 1)
          if (message.id === id) { finish(null, message); return }
        }
      })
    })
    }
}
