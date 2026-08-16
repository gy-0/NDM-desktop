import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statfsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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
  rpcPort?: number
}

type YtDlpFormat = {
  format_id?: string
  format_note?: string
  ext?: string
  height?: number
  filesize?: number
  filesize_approx?: number
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
      const port = this.settings.httpProxyPort ? `:${this.settings.httpProxyPort}` : ''
      options['all-proxy'] = `http://${this.settings.httpProxyHost}${port}`
    } else if (this.settings.socksProxyEnabled && this.settings.socksProxyHost) {
      const port = this.settings.socksProxyPort ? `:${this.settings.socksProxyPort}` : ''
      options['all-proxy'] = `socks5://${this.settings.socksProxyHost}${port}`
    }
    return options
  }

  private async startTask(task: WindowsTask): Promise<void> {
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
      fileSize: 0,
      completedBytes: 0,
      bytesPerSecond: 0,
      connections: clampConnections(extra.connections ?? this.settings.maxConnections),
      bandwidthLimit: 0,
      headers: Array.isArray(extra.headers) ? extra.headers.map(String) : undefined,
      mediaFormatID: typeof extra.mediaFormatID === 'string' ? extra.mediaFormatID : undefined
    }
    this.tasks.unshift(task)
    if (extra.autoStart !== false) await this.startTask(task)
    await this.persist()
    this.broadcast()
    return { ok: true, task: this.publicTask(task) }
  }

  private findDuplicate(extra: Record<string, unknown>): Record<string, unknown> {
    const urls = Array.isArray(extra.urls) ? extra.urls.map(String) : []
    const duplicate = this.tasks.find((task) => urls.includes(task.url) || (!!task.pageURL && urls.includes(task.pageURL)))
    return { ok: true, duplicate: duplicate ? this.publicTask(duplicate) : null }
  }

  private async pause(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
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

  private async stopRpcTask(task: WindowsTask): Promise<void> {
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

  private async restart(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    await this.stopRpcTask(task)
    const path = this.safeTaskFile(task)
    if (path) {
      await unlink(path).catch(() => undefined)
      await unlink(`${path}.aria2`).catch(() => undefined)
    }
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
    await this.stopRpcTask(task)
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
    task.connections = clampConnections(value)
    if (task.gid) {
      await this.rpc.call('changeOption', [task.gid, {
        split: String(task.connections),
        'max-connection-per-server': String(task.connections)
      }]).catch(() => undefined)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async setBandwidth(id: number, value: unknown): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    task.bandwidthLimit = Math.max(0, Number(value) || 0)
    if (task.gid) {
      await this.rpc.call('changeOption', [task.gid, {
        'max-download-limit': String(task.bandwidthLimit || this.settings.bandwidthLimitBytesPerSecond || 0)
      }]).catch(() => undefined)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async remove(id: number, deleteFile: boolean): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    await this.stopRpcTask(task)
    if (deleteFile) {
      const path = this.safeTaskFile(task)
      if (path) {
        if (this.callbacks.trashFile && existsSync(path)) {
          await this.callbacks.trashFile(path).catch(() => undefined)
        } else {
          await unlink(path).catch(() => undefined)
        }
        await unlink(`${path}.aria2`).catch(() => undefined)
      }
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

  private async updateSettings(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof extra.downloadDirectory === 'string' && extra.downloadDirectory.trim()) {
      this.settings.downloadDirectory = extra.downloadDirectory.trim()
      await mkdir(this.settings.downloadDirectory, { recursive: true })
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
      if (typeof extra[key] === 'string') this.settings[key] = extra[key]
    }
    for (const key of ['httpProxyPort', 'socksProxyPort'] as const) {
      if (extra[key] != null) this.settings[key] = Math.max(0, Number(extra[key]) || 0)
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
    args.push('--', url)
    return JSON.parse(await this.runYtDlp(args)) as YtDlpInfo
  }

  private async probeMedia(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(extra.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('媒体解析只支持 HTTP/HTTPS 网页')
    const info = await this.inspectMedia(url, undefined, typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined)
    const candidates = (info.formats ?? [])
      .filter((format) => format.url && format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none')
      .sort((left, right) => Number(right.height ?? 0) - Number(left.height ?? 0))
    const byHeight = new Map<number, YtDlpFormat>()
    for (const candidate of candidates) {
      const height = Math.max(0, Number(candidate.height ?? 0))
      if (!byHeight.has(height)) byHeight.set(height, candidate)
    }
    const formats = Array.from(byHeight.values()).slice(0, 8).map((format) => {
      const height = Math.max(0, Number(format.height ?? 0))
      const bytes = Math.max(0, Number(format.filesize ?? format.filesize_approx ?? 0))
      return {
        id: String(format.format_id ?? 'best'),
        label: height > 0 ? `${height}p` : String(format.format_note ?? '最佳兼容画质'),
        height,
        approximateBytes: bytes,
        componentBytes: bytes ? [bytes] : [],
        compactApproximateBytes: bytes,
        compactComponentBytes: bytes ? [bytes] : [],
        containerHint: String(format.ext ?? 'mp4').toUpperCase(),
        isVideo: true
      }
    })
    if (formats.length === 0 && info.url) {
      const bytes = Math.max(0, Number(info.filesize ?? info.filesize_approx ?? 0))
      formats.push({
        id: String(info.format_id ?? 'best'),
        label: info.height ? `${info.height}p` : '最佳兼容画质',
        height: Math.max(0, Number(info.height ?? 0)),
        approximateBytes: bytes,
        componentBytes: bytes ? [bytes] : [],
        compactApproximateBytes: bytes,
        compactComponentBytes: bytes ? [bytes] : [],
        containerHint: String(info.ext ?? 'mp4').toUpperCase(),
        isVideo: true
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
    const formatID = String(extra.formatID ?? 'best')
    const info = await this.inspectMedia(pageURL, formatID, typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined)
    const selected = info.requested_downloads?.[0] ?? info
    if (!selected.url) throw new Error('没有取得可交给下载引擎的媒体地址')
    const extension = String(selected.ext ?? info.ext ?? 'mp4').toLowerCase()
    const requestedName = String(extra.filename ?? '').trim()
    const filename = sanitizeWindowsFilename(requestedName || `${info.title || '视频'}.${extension}`)
    const headers = Object.entries(selected.http_headers ?? info.http_headers ?? {}).map(([name, value]) => `${name}: ${value}`)
    const reply = await this.add({
      url: pageURL,
      transferURL: selected.url,
      pageURL,
      pageTitle: info.title,
      thumbnailURL: info.thumbnail,
      folderPath: extra.folderPath,
      filename,
      connections: this.settings.maxConnections,
      headers,
      mediaFormatID: formatID,
      autoStart: true
    })
    const task = this.taskById(Number((reply.task as { id: number }).id))
    task.source = sourceFromDownloadUrl(pageURL)
    task.mediaOptions = {
      container: extra.container === 'compactMKV' ? 'compactMKV' : 'compatibleMP4',
      subtitleLanguage: typeof extra.subtitleLanguage === 'string' ? extra.subtitleLanguage : undefined
    }
    task.mediaFormatID = formatID
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
      segments: segmentSnapshot(task.connections, progress),
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
