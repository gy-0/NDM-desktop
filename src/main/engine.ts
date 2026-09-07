import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { app, BrowserWindow, shell } from 'electron'
import { exportCookieHeader } from './browserCookies'
import { WindowsDownloadEngine } from './windows/windowsEngine'

const PORT = Number(process.env.NDM_HOST_PORT ?? 51874)
const SOURCE = process.env.NDM_SOURCE ?? join(app.getAppPath(), 'native')

export type EngineStatus = 'connecting' | 'live' | 'down'

// The payload pushed over `engine:status` and returned by the status invoke.
// `engineError` surfaces the *reason* the engine is not live (missing host
// binary, spawn failure, port unreachable) so the renderer can stop showing
// an endless "connecting" spinner and explain itself instead.
export type EngineStatusPayload = {
  status: EngineStatus
  engineError?: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class EngineClient {
  private child: ChildProcess | null = null
  private windowsEngine: WindowsDownloadEngine | null = null
  // Own the socket while it is connecting, not just after 'connect'. This
  // makes manual retries single-flight and lets stop() cancel startup too.
  private socket: Socket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private hostSpawnTimer: NodeJS.Timeout | null = null
  private respawnAfterExit = false
  private nextId = 1
  private pending = new Map<number, Pending>()
  private attempts = 0
  private started = false
  private stopped = false
  status: EngineStatus = 'connecting'
  // Last failure reason observed while (re)establishing the engine link. Kept
  // across retries so the UI can explain a non-live status; cleared on `live`.
  engineError: string | undefined

  constructor(private readonly onFocusRequest: () => void = () => undefined) {}

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (process.platform === 'win32') {
      const packagedTools = join(process.resourcesPath, 'Tools', 'windows')
      const developmentTools = join(process.cwd(), 'vendor', 'windows')
      const tools = existsSync(join(packagedTools, 'aria2c.exe')) ? packagedTools : developmentTools
      this.windowsEngine = new WindowsDownloadEngine({
        stateDirectory: join(app.getPath('userData'), 'windows-engine'),
        defaultDownloadDirectory: app.getPath('downloads'),
        aria2Path: join(tools, 'aria2c.exe'),
        ytDlpPath: join(tools, 'yt-dlp.exe'),
        ffmpegPath: join(tools, 'ffmpeg.exe')
      }, {
        onEvent: (message) => this.broadcast(message),
        onStatus: (status, engineError) => this.setStatus(status, engineError),
        trashFile: (path) => shell.trashItem(path),
        exportCookies: async (targetURL, browser) => ({
          ok: true,
          ...(await exportCookieHeader(targetURL, browser))
        })
      })
      void this.windowsEngine.start()
      return
    }
    this.connect()
    this.hostSpawnTimer = setTimeout(() => {
      this.hostSpawnTimer = null
      if (this.status !== 'live') this.spawnHost()
    }, 250)
  }

  stop(): void {
    this.stopped = true
    this.clearReconnectTimer()
    this.clearHostSpawnTimer()
    this.respawnAfterExit = false
    void this.windowsEngine?.stop()
    this.failPending(new Error('引擎已停止'))
    const socket = this.socket
    this.socket = null
    socket?.destroy()
    this.child?.kill()
  }

  request(op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('引擎已停止'))
    if (this.windowsEngine) {
      if (this.status !== 'live') return Promise.reject(new Error('引擎还没连上'))
      return this.windowsEngine.request(op, extra)
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket || socket.destroyed || this.status !== 'live') {
        reject(new Error('引擎还没连上'))
        return
      }
      // Serialize before allocating a pending entry. Invalid payloads must not
      // leak timers, and caller data must not override the protocol envelope.
      const frame = JSON.stringify({ ...extra, id, op }) + '\n'
      // yt-dlp probing, DMG installation, and a first-time peek inside a
      // disk image for the inner app icon all mount or probe locally.
      const peekingDiskImage = op === 'fileArtwork'
        && typeof extra.path === 'string'
        && /\.(dmg|iso)$/i.test(extra.path)
      const timeoutMs = op === 'probeMedia' || op === 'installDMG' || peekingDiskImage
        ? 180_000
        : 20_000
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('引擎响应超时'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const failWrite = (error?: Error | null): void => {
        if (!error || !this.pending.delete(id)) return
        clearTimeout(timer)
        reject(error)
      }
      try {
        socket.write(frame, failWrite)
      } catch (error) {
        failWrite(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failPending(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearHostSpawnTimer(): void {
    if (this.hostSpawnTimer) clearTimeout(this.hostSpawnTimer)
    this.hostSpawnTimer = null
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
    const hostEnvironment: Record<string, string | undefined> = {
      ...process.env,
      NDM_HOST_PORT: String(PORT)
    }
    // The host's own tool locator only trusts its bundle in packaged builds;
    // a bare `.build/release/NDMHost` has no Tools next to it, and its DEBUG
    // Vendor fallback is compiled out in release. Without this, every media
    // probe returned an empty format list and known video pages silently
    // degraded to HTML "downloads". Point the host at the real toolchain.
    const packagedTools = join(process.resourcesPath, 'Tools')
    const devTools = join(SOURCE, 'Vendor', 'Tools')
    const toolsDir = existsSync(join(packagedTools, 'yt-dlp'))
      ? packagedTools
      : existsSync(join(devTools, 'yt-dlp'))
        ? devTools
        : null
    if (toolsDir) hostEnvironment.NDM_TOOL_DIR = toolsDir

    if (!bin) {
      console.warn('NDMHost binary missing; trying swift run')
      this.setStatus('connecting', 'NDMHost 二进制缺失，已尝试 swift run')
      this.child = spawn('swift', ['run', '--skip-update', 'NDMHost'], {
        cwd: app.isPackaged ? process.resourcesPath : SOURCE,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hostEnvironment
      })
    } else {
      this.child = spawn(bin, [], {
        cwd: app.isPackaged ? process.resourcesPath : SOURCE,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hostEnvironment
      })
    }
    const child = this.child
    // The host logs to stdout too. Drain it so a full pipe cannot stall it.
    child.stdout?.resume()
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      const respawn = this.respawnAfterExit && this.status !== 'live'
      this.respawnAfterExit = false
      console.warn('NDMHost exited', code)
      if (this.stopped) return
      if (this.status === 'live') {
        this.setStatus('connecting', `NDMHost 进程已退出（code ${code ?? 'unknown'}）`)
      } else {
        this.setStatus('connecting', `NDMHost 进程启动即退出（code ${code ?? 'unknown'}）`)
      }
      // Wait for the old process to exit before starting its replacement.
      // kill() only sends a signal; spawning immediately still sees `child`.
      if (respawn) this.spawnHost()
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.respawnAfterExit = false
      console.warn('NDMHost spawn failed', error)
      if (!this.stopped) {
        this.setStatus('connecting', `NDMHost 启动失败（${error.message || '无法启动进程'}）`)
      }
    })
  }

  private connect(): void {
    if (this.stopped || this.socket) return
    this.clearReconnectTimer()
    // Framing and errors belong to this connection. A truncated final frame
    // from a dead socket must never prefix a reply from its replacement.
    let buffer = ''
    let connectError: string | undefined
    const socket = createConnection({ host: '127.0.0.1', port: PORT })
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      if (this.stopped || this.socket !== socket || socket.destroyed) {
        socket.destroy()
        return
      }
      this.clearHostSpawnTimer()
      this.attempts = 0
      this.setStatus('live')
      void this.request('list')
        .then((reply) => {
          if (this.stopped || this.socket !== socket) return
          const body = reply as { tasks?: unknown }
          if (body.tasks) this.broadcast({ op: 'snapshot', tasks: body.tasks })
        })
        .catch(() => undefined)
    })
    socket.on('data', (chunk: string) => {
      if (this.stopped || this.socket !== socket) return
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.dispatch(JSON.parse(line) as Record<string, unknown>)
        } catch {
          /* ignore malformed frames */
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (this.stopped || this.socket !== socket) return
      // The 'close' handler below performs the status transition; attach the
      // failure reason so the retry loop explains itself.
      const reason = error.code
      connectError = reason === 'ECONNREFUSED' || reason === 'ENOTFOUND'
        ? `端口 ${PORT} 连接失败（${reason}）`
        : `引擎连接错误（${error.message || reason || '未知错误'}）`
      socket.destroy()
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.stopped) return
      this.failPending(new Error('引擎连接已断开'))
      this.attempts += 1
      // Never give up: keep retrying, surface 'down' after a while so the
      // UI can say so, and periodically relaunch the host if it died.
      if (this.attempts > 20) this.setStatus('down', connectError ?? `端口 ${PORT} 长时间无法连接`)
      else this.setStatus('connecting', connectError)
      if (this.attempts % 10 === 0) {
        if (this.child) {
          this.respawnAfterExit = true
          if (!this.child.killed) {
            console.warn('NDMHost unreachable — killing stale child before respawn')
            this.child.kill()
          }
        } else {
          this.spawnHost()
        }
      }
      const delay = Math.min(2000, 400 + this.attempts * 80)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, delay)
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
    if (message.op === 'focusApp') {
      this.onFocusRequest()
      return
    }
    if (message.op === 'snapshot' || message.op === 'openMediaComposer' || message.op === 'installProgress') {
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
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('engine:event', message)
      }
    }
  }

  private setStatus(status: EngineStatus, engineError?: string): void {
    // A live link clears stale failure context; otherwise keep the last
    // reason so non-live states always have something to explain.
    const error = engineError ?? (status === 'live' ? undefined : this.engineError)
    const changed = this.status !== status || this.engineError !== error
    this.status = status
    this.engineError = error
    if (!changed) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('engine:status', { status, engineError: error })
      }
    }
  }

  // Manual "retry" for the UI: reset the backoff counter and immediately
  // attempt a fresh host spawn and/or connection, instead of waiting out the
  // current retry delay.
  retry(): void {
    if (this.stopped || process.platform === 'win32') return
    this.attempts = 0
    if (this.socket) {
      if (this.status !== 'live') this.setStatus('connecting')
      return
    }
    this.clearReconnectTimer()
    if (!this.child) this.spawnHost()
    this.connect()
  }
}
