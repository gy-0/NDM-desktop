import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { BrowserWindow } from 'electron'

const PORT = Number(process.env.NDM_HOST_PORT ?? 51874)
const SOURCE = process.env.NDM_SOURCE ?? join(homedir(), 'NDM')

export type EngineStatus = 'connecting' | 'live' | 'down'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class EngineClient {
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private attempts = 0
  private stopped = false
  status: EngineStatus = 'connecting'

  start(): void {
    this.connect()
    setTimeout(() => {
      if (this.status !== 'live') this.spawnHost()
    }, 250)
  }

  stop(): void {
    this.stopped = true
    this.failPending(new Error('引擎已停止'))
    this.socket?.destroy()
    this.child?.kill()
  }

  request(op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (!this.socket || this.status !== 'live') {
        reject(new Error('引擎还没连上'))
        return
      }
      // yt-dlp probing legitimately takes a while; everything else should be quick.
      const timeoutMs = op === 'probeMedia' ? 180_000 : 20_000
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('引擎响应超时'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ id, op, ...extra }) + '\n')
    })
  }

  private failPending(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }

  private spawnHost(): void {
    if (this.stopped || this.child) return
    const packagedBin = join(process.resourcesPath, 'bin/NDMHost')
    const release = join(SOURCE, '.build/release/NDMHost')
    const debug = join(SOURCE, '.build/debug/NDMHost')
    const bin = existsSync(packagedBin)
      ? packagedBin
      : existsSync(release)
      ? release
      : existsSync(debug)
      ? debug
      : null
    const systemToolDir = ['/opt/homebrew/bin', '/usr/local/bin'].find((directory) =>
      existsSync(join(directory, 'yt-dlp'))
    )
    const hostEnvironment = {
      ...process.env,
      NDM_HOST_PORT: String(PORT),
      // A user-maintained native install avoids the very slow embedded Python
      // network stack on this Mac. Packaged tools remain the offline fallback.
      ...(systemToolDir ? { NDM_TOOL_DIR: systemToolDir } : {})
    }

    if (!bin) {
      console.warn('NDMHost binary missing; trying swift run')
      this.child = spawn('swift', ['run', '--skip-update', 'NDMHost'], {
        cwd: SOURCE,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hostEnvironment
      })
    } else {
      this.child = spawn(bin, [], {
        cwd: SOURCE,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hostEnvironment
      })
    }
    this.child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    this.child.on('exit', (code) => {
      this.child = null
      console.warn('NDMHost exited', code)
      if (!this.stopped && this.status === 'live') this.setStatus('connecting')
    })
    this.child.on('error', (error) => {
      this.child = null
      console.warn('NDMHost spawn failed', error)
    })
  }

  private connect(): void {
    if (this.stopped) return
    const socket = createConnection({ host: '127.0.0.1', port: PORT })
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      this.attempts = 0
      this.socket = socket
      this.setStatus('live')
      void this.request('list')
        .then((reply) => {
          const body = reply as { tasks?: unknown }
          if (body.tasks) this.broadcast({ op: 'snapshot', tasks: body.tasks })
        })
        .catch(() => undefined)
    })
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.dispatch(JSON.parse(line) as Record<string, unknown>)
        } catch {
          /* ignore truncated frames */
        }
      }
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      if (this.stopped) return
      if (this.socket === socket) {
        this.socket = null
        this.failPending(new Error('引擎连接已断开'))
      }
      this.attempts += 1
      // Never give up: keep retrying, surface 'down' after a while so the
      // UI can say so, and periodically relaunch the host if it died.
      this.setStatus(this.attempts > 20 ? 'down' : 'connecting')
      if (this.attempts % 10 === 0) this.spawnHost()
      const delay = Math.min(2000, 400 + this.attempts * 80)
      setTimeout(() => this.connect(), delay)
    })
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok === false) {
        const error = new Error(String(message.error ?? '引擎错误')) as Error & { code?: string }
        if (typeof message.errorKind === 'string') error.code = message.errorKind
        pending.reject(error)
      }
      else pending.resolve(message)
      return
    }
    if (message.op === 'snapshot' || message.op === 'openMediaComposer') {
      if (message.op === 'openMediaComposer') {
        const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
        if (window) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      }
      this.broadcast(message)
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engine:event', message)
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) return
    this.status = status
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engine:status', status)
    }
  }
}
