import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statfsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { formatProxyURL } from '../../shared/proxyEndpoint'
import { Aria2Rpc, type Aria2Status } from './aria2Rpc'
import {
  categoryForFilename,
  clampConnections,
  isSupportedDownloadUrl,
  nameFromDownloadUrl,
  sanitizeWindowsFilename,
  segmentSnapshot,
  sourceFromDownloadUrl,
  type WindowsCategory
} from './engineCore'
import {
  buildMediaFormatTiers,
  isYouTubeMediaURL,
  mediaDownloadArguments,
  parseYtDlpDestinationLine,
  parseYtDlpProgressLine,
  requiresMediaMerge,
  type MediaProgressReport
} from './mediaFormats'

type WindowsTaskStatus = 'downloading' | 'paused' | 'waiting' | 'complete' | 'error' | 'incomplete'

type WindowsTask = {
  id: number
  gid?: string
  url: string
  transferURL?: string
  pageURL?: string
  thumbnailURL?: string
  filename: string
  title: string
  source: string
  category: WindowsCategory
  status: WindowsTaskStatus
  folderPath: string
  fileSize: number
  completedBytes: number
  bytesPerSecond: number
  connections: number
  bandwidthLimit: number
  startAt?: number
  errorText?: string
  completedAt?: number
  headers?: string[]
  mediaFormatID?: string
  mediaOptions?: { container: 'compatibleMP4' | 'compactMKV'; subtitleLanguage?: string }
  mediaCookieBrowser?: string
}

type WindowsSettings = {
  downloadDirectory: string
  maxConnections: number
  bandwidthLimitBytesPerSecond: number
  useCategoryFolders: boolean
  downloadAllAtOnce: boolean
  smartConnections: boolean
  bridgePort: number
  httpProxyHost?: string
  httpProxyPort?: number
  httpProxyEnabled?: boolean
  socksProxyHost?: string
  socksProxyPort?: number
  socksProxyEnabled?: boolean
}

type PersistedState = {
  nextId: number
  tasks: WindowsTask[]
  settings: WindowsSettings
}

type EngineCallbacks = {
  onEvent: (message: Record<string, unknown>) => void
  onStatus: (status: 'connecting' | 'live' | 'down') => void
  trashFile?: (path: string) => Promise<void>
}

export type WindowsEngineOptions = {
  stateDirectory: string
  defaultDownloadDirectory: string
  aria2Path: string
  ytDlpPath: string
  ffmpegPath: string
  rpcPort?: number
}

type YtDlpFormat = {
  format_id?: string
  format_note?: string
  ext?: string
  height?: number
  filesize?: number
  filesize_approx?: number
  tbr?: number
  abr?: number
  vcodec?: string
  acodec?: string
  url?: string
  http_headers?: Record<string, string>
}

type YtDlpInfo = YtDlpFormat & {
  title?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  formats?: YtDlpFormat[]
  requested_downloads?: YtDlpFormat[]
  subtitles?: Record<string, unknown[]>
  automatic_captions?: Record<string, unknown[]>
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

type MediaRun = {
  child: ChildProcess
  stopping: boolean
  stderr: string
  destinationPath?: string
  done: Promise<void>
  finish: () => void
}

export class WindowsDownloadEngine {
  private readonly port: number
  private readonly secret = randomBytes(24).toString('hex')
  private readonly rpc: Aria2Rpc
  private child: ChildProcess | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private stopped = false
  private tasks: WindowsTask[] = []
  private nextId = 1
  private settings: WindowsSettings
  private saveChain: Promise<void> = Promise.resolve()
  private readonly mediaRuns = new Map<number, MediaRun>()
  private readonly mediaProgress = new Map<number, Map<string, MediaProgressReport>>()

  constructor(
    private readonly options: WindowsEngineOptions,
    private readonly callbacks: EngineCallbacks
  ) {
    this.port = options.rpcPort ?? 51875
    this.rpc = new Aria2Rpc(`http://127.0.0.1:${this.port}/jsonrpc`, this.secret)
    this.settings = this.defaultSettings()
  }

  async start(): Promise<void> {
    this.callbacks.onStatus('connecting')
    try {
      await mkdir(this.options.stateDirectory, { recursive: true })
      await mkdir(this.options.defaultDownloadDirectory, { recursive: true })
      await this.loadState()
      if (!existsSync(this.options.aria2Path)) throw new Error('Windows aria2c.exe 未打包')
      this.spawnAria2()
      await this.waitForAria2()
      if (this.stopped) return
      this.callbacks.onStatus('live')
      this.broadcast()
      this.pollTimer = setInterval(() => void this.poll(), 400)
    } catch (error) {
      console.error('Windows download engine failed to start', error)
      this.callbacks.onStatus('down')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    for (const run of this.mediaRuns.values()) {
      run.stopping = true
      this.terminateMediaRun(run)
    }
    for (const task of this.tasks) {
      if (task.status === 'downloading' || task.status === 'waiting') {
        task.status = 'paused'
        task.bytesPerSecond = 0
      }
    }
    void this.persist()
    void this.rpc.call('forceShutdown').catch(() => undefined)
    setTimeout(() => this.child?.kill(), 700).unref()
  }

  async request(op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (op) {
      case 'ping': return { ok: true, engine: 'NDM Windows · aria2', platform: 'win32' }
      case 'list': return { ok: true, tasks: this.snapshot() }
      case 'findDuplicate': return this.findDuplicate(extra)
      case 'getSettings': return { ok: true, settings: this.settings }
      case 'updateSettings': return this.updateSettings(extra)
      case 'add': return this.add(extra)
      case 'addMedia': return this.addMedia(extra)
      case 'probeMedia': return this.probeMedia(extra)
      case 'checkStorage': return this.checkStorage(extra)
      case 'pause': return this.pause(Number(extra.taskID))
      case 'resume': return this.resume(Number(extra.taskID))
      case 'pauseAll': return this.pauseMany(this.tasks.filter((task) => task.status === 'downloading' || task.status === 'waiting'))
      case 'resumeAll': return this.resumeMany(this.tasks.filter((task) => task.status === 'paused' || task.status === 'incomplete'))
      case 'pauseCollection': return this.pauseMany([])
      case 'resumeCollection': return this.resumeMany([])
      case 'restart':
      case 'retry': return this.restart(Number(extra.taskID))
      case 'restartMany': return this.restartMany(extra)
      case 'renew': return this.renew(Number(extra.taskID), String(extra.url ?? ''))
      case 'schedule': return this.schedule(Number(extra.taskID), extra.startAt == null ? undefined : Number(extra.startAt))
      case 'setConnections': return this.setConnections(Number(extra.taskID), extra.connections)
      case 'setBandwidth': return this.setBandwidth(Number(extra.taskID), extra.bandwidthLimit)
      case 'remove': return this.remove(Number(extra.taskID), extra.deleteFile === true)
      case 'removeMany': return this.removeMany(extra)
      default: throw new Error(`Windows 引擎暂不支持操作：${op}`)
    }
  }

  private defaultSettings(): WindowsSettings {
    return {
      downloadDirectory: this.options.defaultDownloadDirectory,
      maxConnections: 8,
      bandwidthLimitBytesPerSecond: 0,
      useCategoryFolders: false,
      downloadAllAtOnce: false,
      smartConnections: true,
      bridgePort: 0
    }
  }

  private statePath(): string {
    return join(this.options.stateDirectory, 'state.json')
  }

  private async loadState(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath(), 'utf8')) as Partial<PersistedState>
      this.tasks = Array.isArray(state.tasks) ? state.tasks : []
      this.nextId = Math.max(Number(state.nextId ?? 1), ...this.tasks.map((task) => task.id + 1), 1)
      this.settings = { ...this.defaultSettings(), ...(state.settings ?? {}) }
      for (const task of this.tasks) {
        task.gid = undefined
        task.bytesPerSecond = 0
        if (task.status === 'downloading' || task.status === 'waiting') task.status = 'paused'
      }
    } catch {
      this.tasks = []
      this.nextId = 1
      this.settings = this.defaultSettings()
    }
  }

  private persist(): Promise<void> {
    // Request headers can contain short-lived authorization material. Keep
    // them in memory for the current transfer, never in the on-disk history.
    const tasks = this.tasks.map(({ headers: _headers, transferURL: _transferURL, ...task }) => task)
    const payload = JSON.stringify({ nextId: this.nextId, tasks, settings: this.settings }, null, 2)
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => writeFile(this.statePath(), payload, 'utf8'))
    return this.saveChain
  }

  private spawnAria2(): void {
    const args = [
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      '--continue=true',
      '--file-allocation=none',
      '--allow-overwrite=false',
      '--auto-file-renaming=true',
      '--check-integrity=true',
      '--max-concurrent-downloads=5',
      '--bt-save-metadata=true',
      '--bt-metadata-only=false',
      '--seed-time=0',
      '--console-log-level=warn',
      '--summary-interval=0'
    ]
    this.child = spawn(this.options.aria2Path, args, {
      cwd: dirname(this.options.aria2Path),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    this.child.on('exit', (code) => {
      this.child = null
      if (!this.stopped) {
        console.warn('aria2c exited', code)
        this.callbacks.onStatus('down')
      }
    })
  }

  private async waitForAria2(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await this.rpc.call('getVersion')
        return
      } catch (error) {
        lastError = error
        await delay(100)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('aria2c 启动超时')
  }

  private taskById(id: number): WindowsTask {
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error('下载任务不存在')
    return task
  }

  private taskOptions(task: WindowsTask): Record<string, unknown> {
    const connections = clampConnections(task.connections)
    const options: Record<string, unknown> = {
      dir: task.folderPath,
      continue: 'true',
      split: String(connections),
      'max-connection-per-server': String(connections),
      'min-split-size': '1M',
      'max-download-limit': String(task.bandwidthLimit || this.settings.bandwidthLimitBytesPerSecond || 0),
      'bt-save-metadata': 'true',
      'bt-metadata-only': 'false',
      'seed-time': '0'
    }
    const transferURL = task.transferURL ?? task.url
    if (!transferURL.startsWith('magnet:')) options.out = task.filename
    if (task.headers?.length) options.header = task.headers
    if (this.settings.httpProxyEnabled && this.settings.httpProxyHost) {
      options['all-proxy'] = formatProxyURL('http', this.settings.httpProxyHost, this.settings.httpProxyPort)
    } else if (this.settings.socksProxyEnabled && this.settings.socksProxyHost) {
      options['all-proxy'] = formatProxyURL('socks5', this.settings.socksProxyHost, this.settings.socksProxyPort)
    }
    return options
  }

  private proxyURL(): string | undefined {
    if (this.settings.httpProxyEnabled && this.settings.httpProxyHost) {
      return formatProxyURL('http', this.settings.httpProxyHost, this.settings.httpProxyPort)
    }
    if (this.settings.socksProxyEnabled && this.settings.socksProxyHost) {
      return formatProxyURL('socks5', this.settings.socksProxyHost, this.settings.socksProxyPort)
    }
    return undefined
  }

  private isMergedMediaTask(task: WindowsTask): boolean {
    return Boolean(task.pageURL && task.mediaFormatID && requiresMediaMerge(task.mediaFormatID))
  }

  private async startTask(task: WindowsTask): Promise<void> {
    if (this.isMergedMediaTask(task)) {
      await this.startMergedMedia(task)
      return
    }
    if (task.pageURL && task.mediaFormatID && !task.transferURL) {
      const info = await this.inspectMedia(task.pageURL, task.mediaFormatID)
      const selected = info.requested_downloads?.[0] ?? info
      if (!selected.url) throw new Error('无法刷新媒体下载地址')
      task.transferURL = selected.url
      task.headers = Object.entries(selected.http_headers ?? info.http_headers ?? {}).map(([name, value]) => `${name}: ${value}`)
    }
    await mkdir(task.folderPath, { recursive: true })
    const gid = await this.rpc.call<string>('addUri', [[task.transferURL ?? task.url], this.taskOptions(task)])
    task.gid = gid
    task.status = 'downloading'
    task.errorText = undefined
    task.startAt = undefined
  }

  private async add(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(extra.url ?? '').trim()
    if (!isSupportedDownloadUrl(url)) throw new Error('支持 HTTP、HTTPS、FTP、磁力链和 .torrent 链接')
    const id = this.nextId++
    const requestedName = String(extra.filename ?? '').trim()
    const filename = sanitizeWindowsFilename(requestedName || nameFromDownloadUrl(url, id))
    const task: WindowsTask = {
      id,
      url,
      transferURL: typeof extra.transferURL === 'string' ? extra.transferURL : undefined,
      pageURL: typeof extra.pageURL === 'string' ? extra.pageURL : undefined,
      thumbnailURL: typeof extra.thumbnailURL === 'string' ? extra.thumbnailURL : undefined,
      filename,
      title: String(extra.pageTitle ?? '').trim() || filename,
      source: sourceFromDownloadUrl(url),
      category: url.startsWith('magnet:') ? 'misc' : categoryForFilename(filename),
      status: 'paused',
      folderPath: String(extra.folderPath ?? '').trim() || this.settings.downloadDirectory,
      fileSize: Math.max(0, Number(extra.fileSize) || 0),
      completedBytes: 0,
      bytesPerSecond: 0,
      connections: clampConnections(extra.connections ?? this.settings.maxConnections),
      bandwidthLimit: 0,
      headers: Array.isArray(extra.headers) ? extra.headers.map(String) : undefined,
      mediaFormatID: typeof extra.mediaFormatID === 'string' ? extra.mediaFormatID : undefined,
      mediaOptions: extra.mediaOptions && typeof extra.mediaOptions === 'object'
        ? {
            container: (extra.mediaOptions as Record<string, unknown>).container === 'compactMKV' ? 'compactMKV' : 'compatibleMP4',
            subtitleLanguage: typeof (extra.mediaOptions as Record<string, unknown>).subtitleLanguage === 'string'
              ? String((extra.mediaOptions as Record<string, unknown>).subtitleLanguage)
              : undefined
          }
        : undefined,
      mediaCookieBrowser: typeof extra.mediaCookieBrowser === 'string' ? extra.mediaCookieBrowser : undefined
    }
    this.tasks.unshift(task)
    if (extra.autoStart !== false) await this.startTask(task)
    await this.persist()
    this.broadcast()
    return { ok: true, task: this.publicTask(task) }
  }

  private async startMergedMedia(task: WindowsTask): Promise<void> {
    if (!existsSync(this.options.ytDlpPath)) throw new Error('Windows yt-dlp.exe 未打包')
    if (!existsSync(this.options.ffmpegPath)) throw new Error('Windows ffmpeg.exe 未打包，无法合并视频与音频')
    if (this.mediaRuns.has(task.id)) return
    await mkdir(task.folderPath, { recursive: true })
    const outputPath = this.safeTaskFile(task)
    if (!outputPath) throw new Error('媒体输出路径无效')
    const bandwidthLimit = task.bandwidthLimit || this.settings.bandwidthLimitBytesPerSecond || 0
    const args = mediaDownloadArguments({
      pageURL: task.pageURL ?? task.url,
      selector: task.mediaFormatID ?? 'bestvideo+bestaudio/best',
      outputPath,
      container: task.mediaOptions?.container ?? 'compatibleMP4',
      ffmpegPath: this.options.ffmpegPath,
      connections: task.connections,
      subtitleLanguage: task.mediaOptions?.subtitleLanguage,
      cookieBrowser: task.mediaCookieBrowser,
      proxy: this.proxyURL(),
      bandwidthLimit
    })
    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const child = spawn(this.options.ytDlpPath, args, {
      cwd: dirname(this.options.ytDlpPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const run: MediaRun = { child, stopping: false, stderr: '', done, finish }
    this.mediaRuns.set(task.id, run)
    this.mediaProgress.set(task.id, new Map())
    task.gid = undefined
    task.status = 'downloading'
    task.errorText = undefined
    task.startAt = undefined
    task.bytesPerSecond = 0
    this.broadcast()

    let stdoutRemainder = ''
    let stderrRemainder = ''
    const consume = (chunk: unknown, stderr: boolean): void => {
      const text = (stderr ? stderrRemainder : stdoutRemainder) + String(chunk)
      const parts = text.split(/\r?\n|\r/g)
      const remainder = parts.pop() ?? ''
      if (stderr) stderrRemainder = remainder
      else stdoutRemainder = remainder
      for (const line of parts) {
        if (stderr && line.trim()) run.stderr = `${run.stderr}\n${line}`.slice(-16_384)
        this.applyMediaOutput(task, run, line)
      }
    }
    child.stdout?.on('data', (chunk) => consume(chunk, false))
    child.stderr?.on('data', (chunk) => consume(chunk, true))
    child.on('error', (error) => {
      run.stderr = `${run.stderr}\n${error.message}`.slice(-16_384)
    })
    child.on('close', (code) => {
      if (stdoutRemainder) this.applyMediaOutput(task, run, stdoutRemainder)
      if (stderrRemainder) {
        run.stderr = `${run.stderr}\n${stderrRemainder}`.slice(-16_384)
        this.applyMediaOutput(task, run, stderrRemainder)
      }
      void this.finishMediaRun(task.id, run, code)
    })
  }

  private applyMediaOutput(task: WindowsTask, run: MediaRun, line: string): void {
    const destination = parseYtDlpDestinationLine(line)
    if (destination) run.destinationPath = destination
    const report = parseYtDlpProgressLine(line)
    if (!report || run.stopping || this.mediaRuns.get(task.id) !== run) return
    const components = this.mediaProgress.get(task.id) ?? new Map<string, MediaProgressReport>()
    const previous = components.get(report.componentID)
    components.set(report.componentID, {
      ...report,
      downloadedBytes: Math.max(previous?.downloadedBytes ?? 0, report.downloadedBytes),
      totalBytes: Math.max(previous?.totalBytes ?? 0, report.totalBytes)
    })
    this.mediaProgress.set(task.id, components)
    const totals = Array.from(components.values())
    const completed = totals.reduce((sum, item) => sum + item.downloadedBytes, 0)
    const total = totals.reduce((sum, item) => sum + item.totalBytes, 0)
    task.completedBytes = Math.max(task.completedBytes, completed)
    task.fileSize = Math.max(task.fileSize, total)
    task.bytesPerSecond = totals.reduce((sum, item) => sum + item.bytesPerSecond, 0)
    task.status = 'downloading'
    void this.persist()
    this.broadcast()
  }

  private async finishMediaRun(taskID: number, run: MediaRun, code: number | null): Promise<void> {
    try {
      if (this.mediaRuns.get(taskID) !== run) return
      this.mediaRuns.delete(taskID)
      this.mediaProgress.delete(taskID)
      const task = this.tasks.find((candidate) => candidate.id === taskID)
      if (!task || run.stopping) return
      task.bytesPerSecond = 0
      if (code === 0) {
        const path = run.destinationPath && dirname(resolve(run.destinationPath)) === resolve(task.folderPath)
          ? run.destinationPath
          : this.safeTaskFile(task)
        const size = path ? (await stat(path).catch(() => null))?.size ?? 0 : 0
        if (size <= 0) throw new Error('媒体合并完成但没有找到输出文件')
        task.status = 'complete'
        task.fileSize = size
        task.completedBytes = size
        task.completedAt = Date.now()
        task.errorText = undefined
      } else {
        task.status = 'error'
        task.errorText = this.mediaErrorMessage(run.stderr, code)
      }
      await this.persist()
      this.broadcast()
    } catch (error) {
      const task = this.tasks.find((candidate) => candidate.id === taskID)
      if (task && !run.stopping) {
        task.status = 'error'
        task.bytesPerSecond = 0
        task.errorText = error instanceof Error ? error.message : String(error)
        await this.persist()
        this.broadcast()
      }
    } finally {
      run.finish()
    }
  }

  private mediaErrorMessage(stderr: string, code: number | null): string {
    const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const detail = lines.slice(-3).join(' · ')
      .replace(/https?:\/\/\S+/gi, '媒体地址')
      .slice(0, 800)
    return detail || `yt-dlp 下载失败（退出码 ${code ?? '未知'}）`
  }

  private terminateMediaRun(run: MediaRun, force = false): void {
    if (process.platform === 'win32' && run.child.pid) {
      execFile('taskkill.exe', ['/pid', String(run.child.pid), '/t', '/f'], { windowsHide: true }, () => undefined)
      return
    }
    run.child.kill(force ? 'SIGKILL' : 'SIGTERM')
  }

  private async stopMediaTask(task: WindowsTask): Promise<void> {
    const run = this.mediaRuns.get(task.id)
    if (!run) return
    run.stopping = true
    this.terminateMediaRun(run)
    const closed = await Promise.race([
      run.done.then(() => true),
      delay(2_000).then(() => false)
    ])
    if (!closed && run.child.exitCode == null) {
      this.terminateMediaRun(run, true)
      await Promise.race([run.done, delay(1_000)])
    }
    if (this.mediaRuns.get(task.id) === run) {
      this.mediaRuns.delete(task.id)
      this.mediaProgress.delete(task.id)
      run.finish()
    }
  }

  private findDuplicate(extra: Record<string, unknown>): Record<string, unknown> {
    const urls = Array.isArray(extra.urls) ? extra.urls.map(String) : []
    const duplicate = this.tasks.find((task) => urls.includes(task.url) || (!!task.pageURL && urls.includes(task.pageURL)))
    return { ok: true, duplicate: duplicate ? this.publicTask(duplicate) : null }
  }

  private async pause(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    await this.stopMediaTask(task)
    if (task.gid && (task.status === 'downloading' || task.status === 'waiting')) {
      await this.rpc.call('forcePause', [task.gid]).catch(() => undefined)
    }
    task.status = 'paused'
    task.bytesPerSecond = 0
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async resume(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    if (task.status === 'complete') return this.restart(id)
    if (task.gid) {
      try {
        await this.rpc.call('unpause', [task.gid])
        task.status = 'downloading'
      } catch {
        task.gid = undefined
        await this.startTask(task)
      }
    } else {
      await this.startTask(task)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async pauseMany(tasks: WindowsTask[]): Promise<Record<string, unknown>> {
    for (const task of tasks) await this.pause(task.id)
    return { ok: true }
  }

  private async resumeMany(tasks: WindowsTask[]): Promise<Record<string, unknown>> {
    for (const task of tasks) await this.resume(task.id)
    return { ok: true }
  }

  private async stopTask(task: WindowsTask): Promise<void> {
    await this.stopMediaTask(task)
    if (!task.gid) return
    await this.rpc.call('forceRemove', [task.gid]).catch(() => undefined)
    await this.rpc.call('removeDownloadResult', [task.gid]).catch(() => undefined)
    task.gid = undefined
  }

  private safeTaskFile(task: WindowsTask): string | null {
    const folder = resolve(task.folderPath)
    const path = resolve(folder, task.filename)
    return dirname(path) === folder ? path : null
  }

  private async removeTaskArtifacts(task: WindowsTask, includeFinal: boolean): Promise<void> {
    const path = this.safeTaskFile(task)
    if (!path) return
    const filename = basename(path)
    const extension = extname(filename)
    const stem = extension ? filename.slice(0, -extension.length) : filename
    const componentPrefixes = (task.mediaFormatID ?? '')
      .split('+')
      .filter((id) => id && !/[\\/]/.test(id))
      .map((id) => `${stem}.f${id}.`)
    const exactSidecars = new Set([
      `${filename}.aria2`,
      `${filename}.part`,
      `${filename}.ytdl`
    ])
    const entries = await readdir(task.folderPath).catch(() => [])
    for (const name of entries) {
      const generated = exactSidecars.has(name)
        || componentPrefixes.some((prefix) => name.startsWith(prefix))
      if ((includeFinal && name === filename) || generated) {
        await unlink(join(task.folderPath, name)).catch(() => undefined)
      }
    }
  }

  private async restart(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    await this.stopTask(task)
    await this.removeTaskArtifacts(task, true)
    task.completedBytes = 0
    task.fileSize = 0
    task.completedAt = undefined
    task.errorText = undefined
    if (task.pageURL && task.mediaFormatID) {
      task.transferURL = undefined
      task.headers = undefined
    }
    await this.startTask(task)
    await this.persist()
    this.broadcast()
    return { ok: true, task: this.publicTask(task) }
  }

  private async renew(id: number, url: string): Promise<Record<string, unknown>> {
    if (!isSupportedDownloadUrl(url)) throw new Error('新的下载链接无效')
    const task = this.taskById(id)
    await this.stopTask(task)
    task.url = url
    task.transferURL = undefined
    task.source = sourceFromDownloadUrl(url)
    task.errorText = undefined
    await this.startTask(task)
    await this.persist()
    this.broadcast()
    return { ok: true, task: this.publicTask(task) }
  }

  private async schedule(id: number, startAt?: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    task.startAt = startAt && Number.isFinite(startAt) ? startAt : undefined
    if (task.startAt && task.startAt > Date.now()) await this.pause(id)
    else if (!task.startAt && task.status === 'paused') task.startAt = undefined
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async setConnections(id: number, value: unknown): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    const restartMedia = this.mediaRuns.has(task.id)
    task.connections = clampConnections(value)
    if (task.gid) {
      await this.rpc.call('changeOption', [task.gid, {
        split: String(task.connections),
        'max-connection-per-server': String(task.connections)
      }]).catch(() => undefined)
    }
    if (restartMedia) {
      await this.stopMediaTask(task)
      await this.startTask(task)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async setBandwidth(id: number, value: unknown): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    const restartMedia = this.mediaRuns.has(task.id)
    task.bandwidthLimit = Math.max(0, Number(value) || 0)
    if (task.gid) {
      await this.rpc.call('changeOption', [task.gid, {
        'max-download-limit': String(task.bandwidthLimit || this.settings.bandwidthLimitBytesPerSecond || 0)
      }]).catch(() => undefined)
    }
    if (restartMedia) {
      await this.stopMediaTask(task)
      await this.startTask(task)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async remove(id: number, deleteFile: boolean): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    await this.stopTask(task)
    if (deleteFile) {
      const path = this.safeTaskFile(task)
      if (path) {
        if (this.callbacks.trashFile && existsSync(path)) {
          await this.callbacks.trashFile(path).catch(() => undefined)
        } else {
          await unlink(path).catch(() => undefined)
        }
      }
      await this.removeTaskArtifacts(task, false)
    }
    this.tasks = this.tasks.filter((candidate) => candidate.id !== id)
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async removeMany(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(extra.taskIDs) ? extra.taskIDs.map(Number).filter(Number.isFinite) : []
    for (const id of ids) await this.remove(id, extra.deleteFile === true)
    return { ok: true }
  }

  private async restartMany(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(extra.taskIDs) ? extra.taskIDs.map(Number).filter(Number.isFinite) : []
    let count = 0
    for (const id of ids) {
      try {
        await this.restart(id)
        count += 1
      } catch {
        // A missing row must not abort the whole cleanup batch.
      }
    }
    return { ok: true, count }
  }

  private async updateSettings(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (const key of ['httpProxyPort', 'socksProxyPort'] as const) {
      if (extra[key] == null) continue
      const port = Number(extra[key])
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('代理端口必须是 1–65535 之间的整数')
      }
    }
    if (typeof extra.downloadDirectory === 'string' && extra.downloadDirectory.trim()) {
      const downloadDirectory = extra.downloadDirectory.trim()
      // Validate the destination before exposing it through getSettings. If
      // mkdir fails (permissions, a file in the path, unavailable volume), the
      // last durable directory must remain the active setting.
      await mkdir(downloadDirectory, { recursive: true })
      this.settings.downloadDirectory = downloadDirectory
    }
    if (extra.maxConnections != null) this.settings.maxConnections = clampConnections(extra.maxConnections)
    if (extra.bandwidthLimitBytesPerSecond != null) {
      this.settings.bandwidthLimitBytesPerSecond = Math.max(0, Number(extra.bandwidthLimitBytesPerSecond) || 0)
      await this.rpc.call('changeGlobalOption', [{
        'max-overall-download-limit': String(this.settings.bandwidthLimitBytesPerSecond)
      }]).catch(() => undefined)
    }
    for (const key of ['useCategoryFolders', 'downloadAllAtOnce', 'smartConnections', 'httpProxyEnabled', 'socksProxyEnabled'] as const) {
      if (typeof extra[key] === 'boolean') this.settings[key] = extra[key]
    }
    for (const key of ['httpProxyHost', 'socksProxyHost'] as const) {
      if (typeof extra[key] === 'string') this.settings[key] = extra[key].trim()
    }
    for (const key of ['httpProxyPort', 'socksProxyPort'] as const) {
      if (extra[key] != null) this.settings[key] = Number(extra[key])
    }
    await this.persist()
    return { ok: true, settings: this.settings }
  }

  private checkStorage(extra: Record<string, unknown>): Record<string, unknown> {
    const folderPath = String(extra.folderPath ?? this.settings.downloadDirectory)
    const finalBytes = Math.max(0, Number(extra.finalBytes) || 0)
    const components = Array.isArray(extra.componentBytes) ? extra.componentBytes.map(Number) : []
    const peakBytes = Math.max(finalBytes, components.reduce((sum, value) => sum + Math.max(0, value || 0), 0))
    try {
      const stats = statfsSync(folderPath, { bigint: true })
      const availableBytes = Number(stats.bavail * stats.bsize)
      const projectedFreeBytes = availableBytes - peakBytes
      const shortfallBytes = Math.max(0, -projectedFreeBytes)
      const level = shortfallBytes > 0 ? 'insufficient' : projectedFreeBytes < peakBytes * 0.2 ? 'tight' : 'comfortable'
      return { ok: true, level, peakBytes, finalBytes, availableBytes, projectedFreeBytes, shortfallBytes, isCollectionEstimate: false }
    } catch {
      return { ok: true, level: 'unknown', peakBytes, finalBytes, availableBytes: 0, projectedFreeBytes: 0, shortfallBytes: 0, isCollectionEstimate: false }
    }
  }

  private runYtDlp(args: string[]): Promise<string> {
    if (!existsSync(this.options.ytDlpPath)) return Promise.reject(new Error('Windows yt-dlp.exe 未打包'))
    return new Promise((resolveOutput, rejectOutput) => {
      execFile(this.options.ytDlpPath, args, {
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error) {
          rejectOutput(new Error(String(stderr || error.message).trim()))
          return
        }
        resolveOutput(stdout)
      })
    })
  }

  private async inspectMedia(url: string, formatID?: string, cookieBrowser?: string): Promise<YtDlpInfo> {
    const args = ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist']
    if (formatID) args.push('-f', formatID)
    if (cookieBrowser) args.push('--cookies-from-browser', cookieBrowser)
    const proxy = this.proxyURL()
    if (proxy) args.push('--proxy', proxy)
    if (existsSync(this.options.ffmpegPath)) args.push('--ffmpeg-location', this.options.ffmpegPath)
    args.push('--', url)
    return JSON.parse(await this.runYtDlp(args)) as YtDlpInfo
  }

  private async probeMedia(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(extra.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('媒体解析只支持 HTTP/HTTPS 网页')
    const info = await this.inspectMedia(url, undefined, typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined)
    const formats = buildMediaFormatTiers(info.formats ?? [], Number(info.duration ?? 0), {
      allowMerging: existsSync(this.options.ffmpegPath),
      includeYouTubeHighBitrate: isYouTubeMediaURL(url)
    })
    if (formats.length === 0 && info.url) {
      const bytes = Math.max(0, Number(info.filesize ?? info.filesize_approx ?? 0))
      const selector = String(info.format_id ?? 'best')
      formats.push({
        id: selector,
        label: info.height ? `${info.height}p` : '最佳兼容画质',
        height: Math.max(0, Number(info.height ?? 0)),
        approximateBytes: bytes,
        componentBytes: bytes ? [bytes] : [],
        compactApproximateBytes: bytes,
        compactComponentBytes: bytes ? [bytes] : [],
        containerHint: String(info.ext ?? 'mp4').toUpperCase(),
        isVideo: true,
        isHighBitrate: false,
        compatibleSelector: selector,
        compactSelector: selector
      })
    }
    const subtitles = [
      ...Object.keys(info.subtitles ?? {}).map((code) => ({ code, displayName: code, isAutomatic: false })),
      ...Object.keys(info.automatic_captions ?? {}).map((code) => ({ code, displayName: code, isAutomatic: true }))
    ]
    const duplicate = this.tasks.find((task) => task.pageURL === url || task.url === url)
    return {
      ok: true,
      title: info.title ?? '',
      duration: Number(info.duration ?? 0),
      thumbnailURL: info.thumbnail,
      mediaURL: info.webpage_url ?? url,
      formats,
      subtitles,
      duplicateCurrent: duplicate ? this.publicTask(duplicate) : undefined
    }
  }

  private async addMedia(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pageURL = String(extra.url ?? '').trim()
    const requestedFormatID = String(extra.formatID ?? 'best')
    const cookieBrowser = typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined
    const container = extra.container === 'compactMKV' ? 'compactMKV' : 'compatibleMP4'
    const probe = await this.inspectMedia(pageURL, undefined, cookieBrowser)
    const tiers = buildMediaFormatTiers(probe.formats ?? [], Number(probe.duration ?? 0), {
      allowMerging: existsSync(this.options.ffmpegPath),
      includeYouTubeHighBitrate: isYouTubeMediaURL(pageURL)
    })
    const tier = tiers.find((candidate) => candidate.id === requestedFormatID)
    if (!tier) throw new Error('所选画质已不可用，请重新选择')
    const formatID = container === 'compactMKV' ? tier.compactSelector : tier.compatibleSelector
    const info = await this.inspectMedia(pageURL, formatID, cookieBrowser)
    const selected = info.requested_downloads?.[0] ?? info
    const merged = requiresMediaMerge(formatID)
    if (!merged && !selected.url) throw new Error('没有取得可交给下载引擎的媒体地址')
    const extension = merged
      ? (container === 'compactMKV' ? 'mkv' : 'mp4')
      : String(selected.ext ?? info.ext ?? 'mp4').toLowerCase()
    const requestedName = String(extra.filename ?? '').trim()
    const baseName = requestedName || `${info.title || probe.title || '视频'}.${extension}`
    const existingExtension = extname(baseName)
    const filename = sanitizeWindowsFilename(
      merged && existingExtension.toLowerCase() !== `.${extension}`
        ? `${existingExtension ? baseName.slice(0, -existingExtension.length) : baseName}.${extension}`
        : baseName
    )
    const headers = Object.entries(selected.http_headers ?? info.http_headers ?? {}).map(([name, value]) => `${name}: ${value}`)
    const estimatedBytes = container === 'compactMKV' ? tier.compactApproximateBytes : tier.approximateBytes
    const reply = await this.add({
      url: pageURL,
      transferURL: merged ? undefined : selected.url,
      pageURL,
      pageTitle: info.title ?? probe.title,
      thumbnailURL: info.thumbnail ?? probe.thumbnail,
      folderPath: extra.folderPath,
      filename,
      connections: this.settings.maxConnections,
      headers: merged ? undefined : headers,
      mediaFormatID: formatID,
      mediaOptions: {
        container,
        subtitleLanguage: typeof extra.subtitleLanguage === 'string' ? extra.subtitleLanguage : undefined
      },
      mediaCookieBrowser: cookieBrowser,
      fileSize: estimatedBytes,
      autoStart: true
    })
    const task = this.taskById(Number((reply.task as { id: number }).id))
    task.source = sourceFromDownloadUrl(pageURL)
    task.category = 'video'
    await this.persist()
    return { ok: true, task: this.publicTask(task), tasks: [this.publicTask(task)] }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    let changed = false
    const scheduled = this.tasks.filter((task) => task.startAt && task.startAt <= Date.now())
    for (const task of scheduled) {
      task.startAt = undefined
      await this.resume(task.id).catch((error) => {
        task.status = 'error'
        task.errorText = error instanceof Error ? error.message : String(error)
      })
      changed = true
    }
    for (const task of this.tasks) {
      if (!task.gid || (task.status !== 'downloading' && task.status !== 'waiting')) continue
      try {
        let status = await this.rpc.call<Aria2Status>('tellStatus', [task.gid])
        if (status.followedBy?.[0]) {
          task.gid = status.followedBy[0]
          status = await this.rpc.call<Aria2Status>('tellStatus', [task.gid])
        }
        this.applyAriaStatus(task, status)
        changed = true
      } catch {
        // A single transient RPC miss must not turn a valid download red.
      }
    }
    if (changed) {
      await this.persist()
      this.broadcast()
    }
  }

  private applyAriaStatus(task: WindowsTask, status: Aria2Status): void {
    const total = Math.max(0, Number(status.totalLength ?? 0))
    const completed = Math.max(0, Number(status.completedLength ?? 0))
    task.fileSize = total
    task.completedBytes = completed
    task.bytesPerSecond = Math.max(0, Number(status.downloadSpeed ?? 0))
    const torrentName = status.bittorrent?.info?.name
    if (torrentName) {
      task.filename = sanitizeWindowsFilename(torrentName)
      task.title = task.filename
      task.category = categoryForFilename(task.filename)
    } else {
      const filePath = status.files?.find((file) => file.path)?.path
      if (filePath && (task.filename.startsWith('下载任务-') || task.filename.startsWith('磁力任务-'))) {
        task.filename = sanitizeWindowsFilename(basename(filePath))
        task.title = task.filename
        task.category = categoryForFilename(task.filename)
      }
    }
    switch (status.status) {
      case 'active': task.status = 'downloading'; break
      case 'waiting': task.status = 'waiting'; break
      case 'paused': task.status = 'paused'; break
      case 'complete':
        task.status = 'complete'
        task.completedBytes = total || completed
        task.bytesPerSecond = 0
        task.completedAt = task.completedAt ?? Date.now()
        break
      case 'error':
      case 'removed':
        task.status = 'error'
        task.bytesPerSecond = 0
        task.errorText = status.errorMessage || 'aria2 下载失败'
        break
    }
  }

  private publicTask(task: WindowsTask): Record<string, unknown> {
    const progress = task.fileSize > 0 ? Math.min(1, task.completedBytes / task.fileSize) : 0
    const mediaComponents = this.mediaProgress.get(task.id)
    const segments = mediaComponents && mediaComponents.size > 0
      ? Array.from(mediaComponents.values()).map((component, index) => ({
          id: index,
          fraction: component.totalBytes > 0 ? Math.min(1, component.downloadedBytes / component.totalBytes) : 0
        }))
      : segmentSnapshot(task.connections, progress)
    return {
      id: task.id,
      url: task.url,
      pageURL: task.pageURL,
      thumbnailURL: task.thumbnailURL,
      filename: task.filename,
      title: task.title,
      source: task.source,
      category: task.category,
      status: task.status,
      fileSize: task.fileSize,
      completedBytes: task.completedBytes,
      progressFraction: progress,
      bytesPerSecond: task.bytesPerSecond,
      connections: task.connections,
      bandwidthLimit: task.bandwidthLimit,
      startAt: task.startAt,
      segments,
      errorText: task.errorText,
      completedAt: task.completedAt,
      folderPath: task.folderPath,
      mediaOptions: task.mediaOptions
    }
  }

  private snapshot(): Record<string, unknown>[] {
    return this.tasks.map((task) => this.publicTask(task))
  }

  private broadcast(): void {
    this.callbacks.onEvent({ op: 'snapshot', tasks: this.snapshot() })
  }
}
