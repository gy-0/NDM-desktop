import { randomUUID } from 'node:crypto'
import { readFile, writeFile, link, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export type OriginalControlOperation = 'pause' | 'resume' | 'cancel-auth' | 'submit-auth'
export type OriginalControlReply = Record<string, unknown> & { nonce: string; ok: boolean }

// The directory belongs to one explicitly launched, isolated reference process.
// Never point this transport at an installed app's profile. No automatic replay.
export class OriginalControl {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string, private readonly timeoutMs = 15_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid control timeout')
  }

  request(operation: OriginalControlOperation, task: string,
    credentials?: { username: string; password: string }): Promise<OriginalControlReply> {
    const run = this.tail.then(() => this.send(operation, task, credentials))
    this.tail = run.catch(() => undefined)
    return run
  }

  private async send(operation: OriginalControlOperation, task: string,
    credentials?: { username: string; password: string }): Promise<OriginalControlReply> {
    if (!['pause', 'resume', 'cancel-auth', 'submit-auth'].includes(operation)
      || !/^[1-9]\d*$/.test(task) || !Number.isSafeInteger(Number(task))) {
      throw new Error('Invalid original-engine command')
    }
    if (operation === 'submit-auth' && (!credentials || typeof credentials.username !== 'string'
      || !credentials.username || typeof credentials.password !== 'string')) throw new Error('Credentials required')
    const nonce = randomUUID()
    const payload = JSON.stringify({ ...(operation === 'submit-auth' ? credentials : {}), nonce, operation, task })
    if (Buffer.byteLength(payload) >= 4096) throw new Error('Original-engine command too large')
    const lockPath = join(this.directory, 'desktop-control.lock')
    // Cross-client/process exclusion. A retained lock means an uncertain command
    // needs reconciliation; its age alone is never permission to replay it.
    const lock = await open(lockPath, 'wx', 0o600)
    const temporary = join(this.directory, `command-${nonce}.tmp`)
    let published = false
    let acknowledged = false
    try {
      await lock.writeFile(JSON.stringify({ nonce, operation, task }))
      await lock.sync()
      await writeFile(temporary, payload, { flag: 'wx', mode: 0o600 })
      // An atomic, no-replace publication: never overwrite another producer's command.
      await link(temporary, join(this.directory, 'command.json'))
      published = true
      const deadline = performance.now() + this.timeoutMs
      while (performance.now() < deadline) {
        let reply: unknown
        try {
          const bytes = await readFile(join(this.directory, 'command-result.json'))
          if (bytes.length > 65536) throw new Error('Original-engine reply too large')
          reply = JSON.parse(bytes.toString('utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (reply && typeof reply === 'object' && 'nonce' in reply && reply.nonce === nonce) {
          if (!('ok' in reply) || typeof reply.ok !== 'boolean') throw new Error('Malformed original-engine reply')
          acknowledged = true
          return reply as OriginalControlReply
        }
        await delay(Math.min(25, Math.max(1, deadline - performance.now())))
      }
      throw new Error('Original-engine command outcome unknown; reconcile before retrying')
    } finally {
      await lock.close()
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      if (!published || acknowledged) await unlink(lockPath)
    }
  }
}
