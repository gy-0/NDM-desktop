import { spawn, type ChildProcess } from 'node:child_process'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OriginalControl } from './control'
import { readOriginalState } from './snapshot'

export type OriginalSessionOptions = {
  directory: string
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  exitTimeoutMs?: number
  onLog?: (chunk: Buffer) => void
}

// Owns only the child created by spawn(), never a PID discovered by process name.
// The caller must first prepare the isolated, pinned reference copy/profile.
export class OriginalSession {
  private child: ChildProcess | undefined
  private startup: Promise<void> | undefined
  private shutdown: Promise<void> | undefined
  private exit: Promise<void> = Promise.resolve()
  private exited = false
  private failure: Error | undefined
  private readonly control: OriginalControl
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'down' = 'idle'

  constructor(private readonly options: OriginalSessionOptions) {
    this.control = new OriginalControl(options.directory)
  }
  get pid(): number | undefined { return this.child?.pid }

  start(): Promise<void> {
    if (this.startup) return this.startup
    if (this.shutdown) return Promise.reject(new Error('Original engine session is closed'))
    this.status = 'starting'
    this.startup = this.launch().catch(error => { this.status = 'down'; throw error })
    return this.startup
  }

  private async launch(): Promise<void> {
    const lockPath = join(this.options.directory, 'desktop-session.lock')
    const lock = await open(lockPath, 'wx', 0o600)
    try { await lock.writeFile(JSON.stringify({ ownerPID: process.pid })); await lock.sync() }
    catch (error) { await unlink(lockPath); throw error }
    finally { await lock.close() }
    let child: ChildProcess
    try {
      child = spawn(this.options.executable, this.options.args, {
        env: this.options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) { await unlink(lockPath); throw error }
    this.child = child
    this.exit = new Promise(resolve => {
      const finish = () => {
        if (this.exited) return
        this.exited = true; this.status = 'down'
        void unlink(lockPath).catch(error => { this.failure = error }).finally(resolve)
      }
      child.once('exit', finish)
      child.once('error', error => { this.failure = error; finish() })
    })
    child.stdout?.on('data', (chunk: Buffer) => this.options.onLog?.(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.options.onLog?.(chunk))
    const deadline = performance.now() + (this.options.startupTimeoutMs ?? 20_000)
    let lastError: unknown
    while (performance.now() < deadline) {
      if (this.exited) throw this.failure ?? new Error('Original engine exited during startup')
      try {
        await readOriginalState(this.options.directory, child.pid!)
        if (this.exited) throw new Error('Original engine exited during startup')
        this.status = 'live'
        return
      } catch (error) { lastError = error }
      await delay(50)
    }
    this.status = 'down'
    // Readiness failure is not permission to kill a potentially active engine.
    throw new Error('Original engine readiness not confirmed', { cause: lastError })
  }

  async snapshot() {
    if (this.status !== 'live' || this.exited || !this.pid) throw new Error('Original engine is not live')
    return (await readOriginalState(this.options.directory, this.pid)).snapshot
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.shutdown = this.settleAndStop().catch(error => {
      this.shutdown = undefined
      if (!this.exited) this.status = 'down'
      throw error
    })
    return this.shutdown
  }

  private async settleAndStop(): Promise<void> {
    // Wait for an in-flight launch before deciding whether there is a child.
    if (this.startup) await this.startup.catch(() => undefined)
    if (!this.child || this.exited) { await this.exit; this.status = 'down'; return }
    // A failed start can still own a live child; require fresh state before stop.
    this.status = 'stopping'
    const before = await readOriginalState(this.options.directory, this.pid!)
    if (before.workers.some(task => task.authenticating || task.waiting)) {
      throw new Error('Original engine has pending interaction; resolve before shutdown')
    }
    for (const worker of before.workers) {
      if (!worker.working) continue
      const reply = await this.control.request('pause', String(worker.id))
      if (!reply.ok || reply.settled !== true || reply.workingAfter !== false) {
        // Completion may remove the window between snapshot and pause delivery.
        // A known reply can be reconciled against newer state, never replayed.
        await delay(250)
        const observed = await readOriginalState(this.options.directory, this.pid!)
        const remaining = observed.workers.find(task => task.id === worker.id)
        if (observed.time <= before.time || (remaining && (remaining.working || remaining.authenticating || remaining.waiting))) {
          throw new Error('Original engine did not settle before shutdown')
        }
      }
    }
    // Require a subsequent sample, rather than rereading a pre-command file.
    const deadline = performance.now() + 5000
    let settled = false
    while (performance.now() < deadline) {
      if (this.exited) { await this.exit; return }
      const current = await readOriginalState(this.options.directory, this.pid!)
      if (current.time > before.time && current.workers.every(task => !task.working && !task.authenticating && !task.waiting)) {
        settled = true
        break
      }
      await delay(50)
    }
    if (!settled) throw new Error('Original engine shutdown state remains uncertain')
    if (this.exited) { await this.exit; return }
    // No SIGKILL fallback, process-name search, restart or command replay.
    if (!this.child.kill('SIGTERM')) throw new Error('Could not signal owned original engine')
    const end = performance.now() + (this.options.exitTimeoutMs ?? 10_000)
    while (!this.exited && performance.now() < end) await delay(25)
    if (!this.exited) throw new Error('Original engine has not exited; process retained')
    await this.exit
  }
}
