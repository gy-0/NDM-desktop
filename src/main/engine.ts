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
}

export class EngineClient {
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  status: EngineStatus = 'connecting'

  start(): void {
    this.connect(0)
    setTimeout(() => {
      if (this.status !== 'live') this.spawnHost()
    }, 250)
  }

  stop(): void {
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
      this.pending.set(id, { resolve, reject })
      this.socket.write(JSON.stringify({ id, op, ...extra }) + '\n')
    })
  }

  private spawnHost(): void {
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

    if (!bin) {
      console.warn('NDMHost binary missing; trying swift run')
      this.child = spawn('swift', ['run', '--skip-update', 'NDMHost'], {
        cwd: SOURCE,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return
    }
    this.child = spawn(bin, [], {
      cwd: SOURCE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NDM_HOST_PORT: String(PORT) }
    })
    this.child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    this.child.on('exit', (code) => {
      if (this.status === 'live') this.setStatus('down')
      console.warn('NDMHost exited', code)
    })
  }

  private connect(attempt: number): void {
    const socket = createConnection({ host: '127.0.0.1', port: PORT })
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      this.socket = socket
      this.setStatus('live')
      void this.request('list').then((reply) => {
        const body = reply as { tasks?: unknown }
        if (body.tasks) this.broadcast({ op: 'snapshot', tasks: body.tasks })
      })
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
      if (this.socket === socket) this.socket = null
      if (attempt < 40) {
        this.setStatus('connecting')
        setTimeout(() => this.connect(attempt + 1), 400)
      } else {
        this.setStatus('down')
      }
    })
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.ok === false) pending.reject(new Error(String(message.error ?? '引擎错误')))
      else pending.resolve(message)
      return
    }
    if (message.op === 'snapshot') this.broadcast(message)
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engine:event', message)
    }
  }

  private setStatus(status: EngineStatus): void {
    this.status = status
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engine:status', status)
    }
  }
}
