import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statfsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { preferredProxyURL } from '../../shared/proxyEndpoint'
import { DirectoryRulesService } from '../directoryRules'
import { resolveDirectoryRule } from '../../shared/directoryRules'
import { WindowsBTGlobalConfiguration } from './auxiliaryBTControls'
import { BT_ERROR_MESSAGES, btFailure, canConfigureBT, isBTEncryption, type BTErrorCode } from '../../shared/btTransferControls'
import { WindowsBandwidthBudget, type BandwidthDemand, type BandwidthAllocation, type BandwidthEngine } from './bandwidthBudget'
import { Aria2Rpc, type Aria2Status } from './aria2Rpc'
import { auxiliaryProxyPlan, assertAuxiliaryProxyProtocol, WindowsAuxiliaryProxyError, WindowsProxyOperationGate, type AuxiliaryProxyCode } from './auxiliaryProxy'
import { WindowsAuxiliaryDaemon, type WindowsAuxiliaryDaemonProvider } from './auxiliaryDaemon'
import { WindowsAuxiliaryTransfer, auxiliaryKind, validateWindowsAuxiliarySource, validPublishedArtifact, type WindowsAuxiliaryTaskState, type WindowsAuxiliaryCredentials } from './auxiliaryTransfer'
import { readAuxiliarySnapshot, AUXILIARY_ERROR_MESSAGES, type AuxiliarySnapshot } from '../../shared/auxiliaryTransfer'
import { formatAria2Error, sanitizeDownloadError } from './aria2Errors'
import { creationIntentDigest, decodeCreationReceipts, normalizeCreationKey, writeAtomicWindowsState, type WindowsCreationReceipt } from './creationReceipts'
import {
  categoryForFilename,
  clampConnections,
  isSupportedDownloadUrl,
  nameFromDownloadUrl,
  ownedTaskArtifactNames,
  sanitizeWindowsFilename,
  segmentSnapshot,
  sourceFromDownloadUrl,
  validateMirrorURLs,
  type WindowsCategory
} from './engineCore'
import {
  buildMediaFormatTiers,
  isPlayableMediaInfo,
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
  queueRank?: number
  auxiliary?: WindowsAuxiliaryTaskState
  gid?: string
  url: string
  mirrorURLs?: string[]
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
  createdAt?: number
  startAt?: number
  errorText?: string
  completedAt?: number
  headers?: string[]
  /** Browser name behind the Cookie header. Persisted; the header itself never is. */
  cookieBrowser?: string
  mediaFormatID?: string
  mediaComponentBytes?: number[]
  mediaOptions?: { container: 'compatibleMP4' | 'compactMKV'; subtitleLanguage?: string }
  mediaCookieBrowser?: string
  generation?: number
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
  creationReceipts?: { version: 1; entries: WindowsCreationReceipt[] }
}

type EngineCallbacks = {
  onEvent: (message: Record<string, unknown>) => void
  onStatus: (status: 'connecting' | 'live' | 'down', engineError?: string) => void
  trashFile?: (path: string) => Promise<void>
  /**
   * Re-derive the Cookie header for a task that was authorized through a
   * browser session earlier. Only the browser NAME persists on disk, so a
   * restart after app relaunch must export a fresh header or the download
   * hits the login wall again. Failing here must never block an ordinary
   * start: the engine still tries with whatever headers exist.
   */
  exportCookies?: (targetURL: string, browser: string) => Promise<{ ok: boolean; header?: string; error?: string }>
}

export type WindowsEngineOptions = {
  stateDirectory: string
  directoryRulesPath?: string
  defaultDownloadDirectory: string
  aria2Path: string
  ytDlpPath: string
  ffmpegPath: string
  rpcPort?: number
  auxiliaryPath?: string
  auxiliaryManifestPath?: string
  auxiliaryLoopbackOnly?: boolean
  auxiliaryPeerDiscovery?: boolean
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
  // Kept distinct from `child` when a stop is in flight: a delayed kill must
  // target the exact process it was scheduled for, never a replacement spawned
  // by a subsequent start. Guards the stop() kill timer below.
  private stoppedChild: ChildProcess | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private stopped = false
  private tasks: WindowsTask[] = []
  private nextId = 1
  private settings: WindowsSettings
  private saveChain: Promise<void> = Promise.resolve()
  private stateLoad: Promise<void> | null = null
  private readonly pendingCreations = new Map<string, { intentDigest: string; result: Promise<Record<string, unknown>> }>()
  private creationReceipts = new Map<string, WindowsCreationReceipt>()
  private readonly mediaRuns = new Map<number, MediaRun>()
  private readonly mediaProgress = new Map<number, Map<string, MediaProgressReport>>()
  private readonly ariaStatusApplications = new Map<number, Promise<void>>()
  private readonly taskOperationTails = new Map<number, Promise<void>>()
  private pollInFlight = false
  private queueOperationTail: Promise<unknown> = Promise.resolve()
  private directoryRuleService?: DirectoryRulesService
  private readonly auxiliaryTransfers = new Map<number, WindowsAuxiliaryTransfer>()
  private readonly auxiliaryCredentials = new Map<number, WindowsAuxiliaryCredentials>()
  private readonly auxiliaryDaemon: WindowsAuxiliaryDaemonProvider
  private readonly bandwidthBudget: WindowsBandwidthBudget
  private readonly btGlobalConfiguration: WindowsBTGlobalConfiguration
  private primaryReady = false
  private readonly bandwidthAdmissions = new Set<number>()
  private bandwidthOperations: Promise<unknown> = Promise.resolve()
  private auxiliaryBudgetApplied = false
  private readonly proxyOperations = new WindowsProxyOperationGate()
  private auxiliaryProxyUnavailable = false

  constructor(
    private readonly options: WindowsEngineOptions,
    private readonly callbacks: EngineCallbacks
  ) {
    this.port = options.rpcPort ?? 51875
    this.rpc = new Aria2Rpc(`http://127.0.0.1:${this.port}/jsonrpc`, this.secret)
    this.settings = this.defaultSettings()
    this.btGlobalConfiguration = new WindowsBTGlobalConfiguration(join(options.stateDirectory, 'bt-global.json'))
    const auxiliaryPath = options.auxiliaryPath ?? join(dirname(options.aria2Path), 'aria2-next.exe')
    this.auxiliaryDaemon = new WindowsAuxiliaryDaemon({ binaryPath: auxiliaryPath,
      manifestPath: options.auxiliaryManifestPath ?? join(dirname(auxiliaryPath), 'aria2-next-manifest.json'),
      stateDirectory: join(options.stateDirectory, 'auxiliary-daemon'), loopbackOnly: options.auxiliaryLoopbackOnly, peerDiscovery: options.auxiliaryPeerDiscovery,
      beforeLaunch: async () => ({ downloadLimit: (await this.reconcileBandwidth()).auxiliary, encryption: await this.btGlobalConfiguration.startupEncryption(), proxy: auxiliaryProxyPlan(this.settings) }) })
    this.bandwidthBudget = new WindowsBandwidthBudget({
      readCap: async engine => {
        const rpc = this.bandwidthRPC(engine)
        if (!rpc) return null
        const options = await rpc.call<Record<string, string>>(engine === 'primary' ? 'getGlobalOption' : 'aria2.getGlobalOption')
        const raw = options?.['max-overall-download-limit']
        if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('未能读取实际总限速。')
        return Number(raw)
      },
      writeCap: async (engine, value) => {
        const rpc = this.bandwidthRPC(engine)
        if (!rpc) throw new Error('下载引擎尚未启动。')
        await rpc.call(engine === 'primary' ? 'changeGlobalOption' : 'aria2.changeGlobalOption', [{ 'max-overall-download-limit': String(value) }])
      }
    })
  }

  async start(): Promise<void> {
    this.callbacks.onStatus('connecting')
    try {
      await mkdir(this.options.stateDirectory, { recursive: true })
      await mkdir(this.options.defaultDownloadDirectory, { recursive: true })
      await this.loadState()
      const completedTemporaryDirectories = this.tasks
        .filter((task) => task.status === 'complete')
        .map((task) => this.removeMediaTemporaryDirectory(task))
      // Stale staging cleanup must not block engine startup on a few failures.
      await Promise.allSettled(completedTemporaryDirectories)
      if (!existsSync(this.options.aria2Path)) throw new Error('Windows aria2c.exe 未打包')
      const startupBudget = await this.reconcileBandwidth()
      this.spawnAria2(startupBudget.primary)
      await this.waitForAria2()
      this.primaryReady = true
      if (this.stopped) return
      this.callbacks.onStatus('live')
      this.broadcast()
      this.pollTimer = setInterval(() => void this.poll(), 400)
    } catch (error) {
      console.error('Windows download engine failed to start', error)
      this.callbacks.onStatus('down', error instanceof Error ? error.message : String(error))
    }
  }

  async stop(): Promise<void> {
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
    // Await the final snapshot so the paused state survives the shutdown,
    // instead of racing the process exit. Writes are serialized on
    // `saveChain`, so this also flushes any persistence already queued.
    await this.persist()
    await this.auxiliaryDaemon.stop()
    this.primaryReady = false
    this.auxiliaryCredentials.clear()
    this.auxiliaryTransfers.clear()
    void this.rpc.call('forceShutdown').catch(() => undefined)
    const stoppedChild = this.child
    this.stoppedChild = stoppedChild
    setTimeout(() => {
      if (this.stoppedChild === stoppedChild) {
        if (stoppedChild === this.child) this.child = null
        this.stoppedChild = null
        stoppedChild?.kill()
      }
    }, 700).unref()
  }

  async request(op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.proxyOperations.run(op === 'updateSettings', async () => {
      try { return await this.requestUnlocked(op, extra) }
      catch (error) {
        if (error instanceof WindowsAuxiliaryProxyError) return { ok: false, code: error.code, error: error.message }
        throw error
      }
    })
  }

  private async requestUnlocked(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    // An early renderer request must not mistake an unread receipt ledger for
    // an empty one while start() is still bringing up aria2.
    await this.loadState()
    switch (op) {
      case 'auxiliaryBTGlobalStatus':
      case 'auxiliaryBTGlobalConfigure': return this.withBandwidthOperation(() => this.controlBTGlobal(op, extra))
      case 'auxiliaryBTStatus':
      case 'auxiliaryBTConfigure':
      case 'auxiliaryBTAddPeers': return this.withTaskOperation(Number(extra.taskID), () => this.controlBTTask(op, extra))
      case 'auxiliaryCapabilities': {
        try { return { ok: true, capabilities: await this.auxiliaryDaemon.start() } }
        catch { return { ok: true, capabilities: { bittorrent: false, ed2k: false, sftp: false, fileSelection: false, stopSeeding: false }, code: 'unavailable' } }
      }
      case 'auxiliaryCreate': return this.createAuxiliary(extra)
      case 'auxiliaryStatus': return this.withTaskOperation(Number(extra.taskID), async () => ({ ok: true, snapshot: await this.refreshAuxiliary(this.taskById(Number(extra.taskID))) }))
      case 'auxiliarySelectFiles':
      case 'auxiliaryStopSeeding':
      case 'auxiliaryAuthenticate': return this.withTaskOperation(Number(extra.taskID), () => this.controlAuxiliary(op, extra))
      case 'ping': return { ok: true, engine: 'NDM Windows · aria2', platform: 'win32' }
      case 'list': return { ok: true, tasks: this.snapshot() }
      case 'getWaitingQueue': return { ok: true, tasks: (await this.waitingQueue()).tasks.map(task => this.publicTask(task)) }
      case 'moveQueuedTask': return this.moveQueuedTask(extra)
      case 'findDuplicate': return this.findDuplicate(extra)
      case 'getSettings': return { ok: true, settings: this.settings }
      case 'directoryRulesFallback': return { ok: true, directory: this.fallbackDirectory(String(extra.url ?? ''), typeof extra.filename === 'string' ? extra.filename : undefined) }
      case 'directoryRulesReload': {
        const service = this.makeDirectoryRuleService()
        await service.getConfig()
        this.directoryRuleService = service
        return { ok: true }
      }
      case 'updateSettings': return this.updateSettings(extra)
      case 'add': return this.withCreationReceipt('add', extra, (receipt) => /^magnet:/i.test(String(extra.url ?? ''))
        ? this.addAuxiliary({ ...extra, source: { kind: 'magnet', url: extra.url }, autoStart: false }, receipt)
        : this.add(extra, receipt))
      case 'addMedia': return this.withCreationReceipt('addMedia', extra, (receipt) => this.addMedia(extra, receipt))
      case 'getCreationReceipt': return this.getCreationReceipt(extra.creationKey)
      case 'probeMedia': return this.probeMedia(extra)
      case 'checkStorage': return this.checkStorage(extra)
      case 'pause': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.pause(id))
      }
      case 'resume': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.resume(id))
      }
      case 'pauseAll': return this.pauseMany(this.tasks.filter((task) => task.status === 'downloading' || task.status === 'waiting'))
      case 'resumeAll': return this.resumeMany(this.tasks.filter((task) => task.status === 'paused' || task.status === 'incomplete'))
      case 'pauseCollection': return this.pauseMany([])
      case 'resumeCollection': return this.resumeMany([])
      case 'restart':
      case 'retry': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.restart(id))
      }
      case 'restartMany': return this.restartMany(extra)
      case 'renew': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.renew(id, String(extra.url ?? '')))
      }
      case 'schedule': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.schedule(id, extra.startAt == null ? undefined : Number(extra.startAt)))
      }
      case 'setConnections': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.setConnections(id, extra.connections))
      }
      case 'setBandwidth': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.setBandwidth(id, extra.bandwidthLimit))
      }
      case 'remove': {
        const id = Number(extra.taskID)
        return this.withTaskOperation(id, () => this.remove(id, extra.deleteFile === true))
      }
      case 'removeMany': return this.removeMany(extra)
      default: throw new Error(`Windows 引擎暂不支持操作：${op}`)
    }
  }

  private async withTaskOperation<T>(id: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskOperationTails.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.taskOperationTails.set(id, tail)

    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.taskOperationTails.get(id) === tail) this.taskOperationTails.delete(id)
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

  private loadState(): Promise<void> {
    this.stateLoad ??= this.readState()
    return this.stateLoad
  }

  private async readState(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath(), 'utf8')) as Partial<PersistedState>
      if (!state || typeof state !== 'object' || Array.isArray(state)
          || (state.tasks !== undefined && !Array.isArray(state.tasks))) throw new Error('下载记录无法读取')
      this.creationReceipts = decodeCreationReceipts(state.creationReceipts)
      this.tasks = Array.isArray(state.tasks) ? state.tasks : []
      this.nextId = Math.max(Number(state.nextId ?? 1), 1)
      for (const task of this.tasks) this.nextId = Math.max(this.nextId, task.id + 1)
      for (const receipt of this.creationReceipts.values()) this.nextId = Math.max(this.nextId, receipt.taskID + 1)
      if (!Number.isSafeInteger(this.nextId)) throw new Error('下载记录无法读取')
      this.settings = { ...this.defaultSettings(), ...(state.settings ?? {}) }
      for (const task of this.tasks) {
        if (task.auxiliary) {
          const state = task.auxiliary
          state.source = validateWindowsAuxiliarySource(state.source)
          if (!Number.isSafeInteger(state.generation) || state.generation < 1 || typeof state.sourceFilename !== 'string' || sanitizeWindowsFilename(state.sourceFilename) !== state.sourceFilename
            || state.published !== undefined && !validPublishedArtifact(state.published)) throw new Error('辅助任务恢复记录无效。')
          if (state.snapshot) {
            const snapshot = readAuxiliarySnapshot({ ok: true, snapshot: state.snapshot }, task.id)
            if (!snapshot || snapshot.generation !== state.generation || snapshot.kind !== auxiliaryKind(state.source)) throw new Error('辅助任务状态记录无效。')
            state.snapshot = snapshot
          }
        }
        if (!Number.isSafeInteger(task.queueRank) || Number(task.queueRank) < 0) task.queueRank = undefined
        task.gid = undefined
        task.bytesPerSecond = 0
        if (task.status === 'downloading' || task.status === 'waiting') task.status = 'paused'
      }
    } catch (error) {
      // A corrupt/unreadable ledger is not proof that an operation never ran.
      // Preserve it and fail closed instead of replacing it with an empty library.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.tasks = []
      this.nextId = 1
      this.settings = this.defaultSettings()
      this.creationReceipts = new Map()
    }
  }

  private statePayload(tasks = this.tasks, receipts = this.creationReceipts, nextId = this.nextId): string {
    // Request headers can contain short-lived authorization material. Keep
    // them in memory for the current transfer, never in the on-disk history.
    const publicHistory = tasks.map(({ headers: _headers, transferURL: _transferURL, ...task }) => task)
    return JSON.stringify({ nextId, tasks: publicHistory, settings: this.settings,
      creationReceipts: { version: 1, entries: Array.from(receipts.values()) } }, null, 2)
  }

  private writeState(payload: string): Promise<void> {
    return writeAtomicWindowsState(this.statePath(), payload)
  }

  private enqueueStateWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.saveChain.catch(() => undefined).then(operation)
    // Keep failures on the result returned to the caller; a later legitimate
    // write can still proceed after a recovered filesystem failure.
    this.saveChain = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(): Promise<void> {
    await this.loadState()
    // Take the snapshot when the writer reaches it, not when it is enqueued:
    // an older poll/save must never overwrite a newly committed receipt.
    const result = this.enqueueStateWrite(() => this.writeState(this.statePayload()))
    if (this.stopped) await this.saveChain
    return result
  }

  private getCreationReceipt(value: unknown): Record<string, unknown> {
    const key = normalizeCreationKey(value)
    const receipt = this.creationReceipts.get(key)
    if (!receipt) return { ok: true, receipt: null, ...(this.pendingCreations.has(key) ? { pending: true } : {}) }
    const task = this.tasks.find((candidate) => candidate.id === receipt.taskID)
    return { ok: true, receipt: { taskID: receipt.taskID, taskExists: Boolean(task) },
      ...(task ? { task: this.publicTask(task) } : {}) }
  }

  private async withCreationReceipt(
    operation: 'add' | 'addMedia', extra: Record<string, unknown>,
    create: (receipt?: Omit<WindowsCreationReceipt, 'taskID'>) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    if (operation === 'add' && /^magnet:/i.test(String(extra.url ?? '')) && ((Array.isArray(extra.headers) && extra.headers.length) || (Array.isArray(extra.mirrors) && extra.mirrors.length) || extra.pageURL || extra.cookieBrowser)) throw new Error('磁力任务请使用独立协议入口，不能附带 HTTP 镜像或凭据。')
    if (operation === 'add') validateMirrorURLs(String(extra.url ?? '').trim(), extra.mirrors, {
      headers: Array.isArray(extra.headers) ? extra.headers.map(String) : undefined,
      pageURL: typeof extra.pageURL === 'string' ? extra.pageURL : undefined,
      cookieBrowser: typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined
    })
    if (extra.creationKey === undefined) return create()
    const key = normalizeCreationKey(extra.creationKey)
    const intentDigest = creationIntentDigest(operation, extra)
    const receipt = this.creationReceipts.get(key)
    const pending = this.pendingCreations.get(key)
    if ((receipt && receipt.intentDigest !== intentDigest) || (pending && pending.intentDigest !== intentDigest)) {
      throw new Error('这项添加请求已更改，请重新建立下载')
    }
    if (receipt) return this.getCreationReceipt(key)
    if (pending) return pending.result
    if (this.stopped) throw new Error('下载引擎正在退出，请稍后重试')
    // Register before parsing media or writing state yields to another request.
    const result = Promise.resolve().then(() => create({ creationKey: key, intentDigest }))
    this.pendingCreations.set(key, { intentDigest, result })
    try {
      return await result
    } finally {
      if (this.pendingCreations.get(key)?.result === result) this.pendingCreations.delete(key)
    }
  }

  private spawnAria2(downloadLimit = this.settings.bandwidthLimitBytesPerSecond): void {
    const args = [
      '--no-conf=true',
      '--no-netrc=true',
      `--max-overall-download-limit=${downloadLimit}`,
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
      this.primaryReady = false
      this.child = null
      if (!this.stopped) {
        console.warn('aria2c exited', code)
        this.callbacks.onStatus('down', `aria2c 进程退出（code ${code ?? 'unknown'}）`)
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
    const proxy = preferredProxyURL(this.settings)
    if (proxy) options['all-proxy'] = proxy
    return options
  }

  private proxyURL(): string | undefined {
    return preferredProxyURL(this.settings)
  }

  /**
   * A task authorized with browser cookies keeps only the browser NAME across
   * restarts (headers are stripped before persisting). Before the transfer
   * resumes, re-export a fresh header; sessions rotate, so the value from
   * add time is often dead anyway. A failed export degrades to the previous
   * behavior (start without cookies) instead of blocking the retry.
   */
  private async refreshCookieSession(task: WindowsTask): Promise<void> {
    const browser = task.cookieBrowser
    if (!browser) return
    const exporter = this.callbacks.exportCookies
    if (!exporter) return
    const target = task.transferURL ?? task.url
    try {
      const session = await exporter(target, browser)
      if (session?.ok && session.header) {
        task.headers = [`Cookie: ${session.header}`]
      }
    } catch {
      // Login-wall resumes degrade to an unauthenticated start; the user's
      // browser may simply not be unlocked right now.
    }
  }

  private isMergedMediaTask(task: WindowsTask): boolean {
    return Boolean(task.pageURL && task.mediaFormatID && requiresMediaMerge(task.mediaFormatID))
  }

  private btFailureFrom(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : ''
    // invalidRequest is exclusively a main-process pre-dispatch guarantee.
    const code = message !== 'invalidRequest' && Object.hasOwn(BT_ERROR_MESSAGES, message) ? message as BTErrorCode : 'unconfirmed'
    return btFailure(code)
  }
  private async controlBTTask(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const task = this.taskById(Number(extra.taskID))
      if (!task.auxiliary || auxiliaryKind(task.auxiliary.source) !== 'bittorrent') return btFailure('unsupported')
      if (extra.generation !== task.auxiliary.generation) return btFailure('staleGeneration')
      const transfer = await this.auxiliaryTransfer(task)
      if (op === 'auxiliaryBTAddPeers') return { ok: true, ...await transfer.btAddPeers(extra.peers) }
      const state = op === 'auxiliaryBTConfigure' ? await transfer.btConfigure(Number(extra.expectedRevision), extra.config) : await transfer.btStatus()
      return { ok: true, state }
    } catch (error) { return this.btFailureFrom(error) }
  }
  private async controlBTGlobal(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const rpc = await this.auxiliaryDaemon.rpc()
      let canConfigure = true
      for (const task of this.tasks) if (task.auxiliary && auxiliaryKind(task.auxiliary.source) === 'bittorrent' && !task.auxiliary.published) {
        const snapshot = await (await this.auxiliaryTransfer(task)).status()
        if (!canConfigureBT(snapshot.phase)) canConfigure = false
      }
      // Include unknown/lost-ACK admissions owned by this shared process.
      const [active, waiting] = await Promise.all([rpc.call<any[]>('aria2.tellActive', [['bittorrent']]), rpc.call<any[]>('aria2.tellWaiting', [0, 100000, ['bittorrent','status']])])
      if (!Array.isArray(active) || !Array.isArray(waiting)) throw new Error('unavailable')
      if (active.some(row => row.bittorrent) || waiting.some(row => row.bittorrent && row.status !== 'paused')) canConfigure = false
      if (op === 'auxiliaryBTGlobalConfigure') {
        if (!Number.isSafeInteger(extra.expectedRevision) || !isBTEncryption(extra.encryption)) return btFailure('invalidConfig')
        return { ok: true, state: await this.btGlobalConfiguration.configure(rpc, Number(extra.expectedRevision), extra.encryption, canConfigure) }
      }
      return { ok: true, state: await this.btGlobalConfiguration.status(rpc, canConfigure) }
    } catch (error) { return this.btFailureFrom(error) }
  }

  private bandwidthRPC(engine: BandwidthEngine): { call<T = unknown>(method: string, params?: unknown[]): Promise<T> } | null {
    return engine === 'primary' ? this.primaryReady ? this.rpc : null : this.auxiliaryDaemon.peekRPC?.() ?? null
  }
  private withBandwidthOperation<T>(action: () => Promise<T>): Promise<T> {
    const next = this.bandwidthOperations.catch(() => undefined).then(action)
    this.bandwidthOperations = next.catch(() => undefined)
    return next
  }
  private async bandwidthDemand(): Promise<BandwidthDemand> {
    const demand: BandwidthDemand = { primary: false, auxiliary: false }
    for (const task of this.tasks) if (this.bandwidthAdmissions.has(task.id) || ['downloading', 'waiting'].includes(task.status)) demand[task.auxiliary ? 'auxiliary' : 'primary'] = true
    // Admission ACKs can be lost. Runtime demand also covers tasks whose RPC
    // outcome was uncertain, so their process never silently loses its budget.
    for (const engine of ['primary', 'auxiliary'] as const) {
      const rpc = this.bandwidthRPC(engine)
      if (!rpc) continue
      const stat = await rpc.call<Record<string, string>>(engine === 'primary' ? 'getGlobalStat' : 'aria2.getGlobalStat')
      const counts = [stat?.numActive, stat?.numWaiting]
      if (counts.some(value => typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('未能确认下载引擎是否正在传输。')
      if (Number(counts[0]) > 0) demand[engine] = true
      else if (Number(counts[1]) > 0) {
        // aria2 includes paused reserved requests in numWaiting.
        const waiting = await rpc.call<Array<{ status: string }>>(engine === 'primary' ? 'tellWaiting' : 'aria2.tellWaiting', [0, 100000, ['status']])
        if (!Array.isArray(waiting) || waiting.some(row => !row || !['paused', 'waiting'].includes(row.status))) throw new Error('未能确认待处理下载是否已暂停。')
        if (waiting.some(row => row.status === 'waiting')) demand[engine] = true
      }
    }
    return demand
  }
  private async reconcileBandwidth(total = this.settings.bandwidthLimitBytesPerSecond, userOverrides = new Map<number, number>()): Promise<BandwidthAllocation> {
    const allocation = await this.bandwidthBudget.reconcile(total, total === 0 ? { primary: false, auxiliary: false } : await this.bandwidthDemand())
    if (total > 0 || this.auxiliaryBudgetApplied || userOverrides.size) await this.reconcileAuxiliaryTaskCaps(allocation.auxiliary, userOverrides)
    return allocation
  }
  private async reconcileAuxiliaryTaskCaps(allocation: number, userOverrides: Map<number, number>): Promise<void> {
    const rpc = this.auxiliaryDaemon.peekRPC?.()
    if (!rpc) return
    const bindings = new Map<string, { id: number; userLimit: number }>()
    for (const [id, transfer] of this.auxiliaryTransfers) { const binding = await transfer.budgetIdentity(); bindings.set(binding.gid, { id, userLimit: userOverrides.get(id) ?? binding.userLimit }) }
    const [active, reserved] = await Promise.all([rpc.call<Array<{ gid: string; status: string }>>('aria2.tellActive', [['gid','status']]), rpc.call<Array<{ gid: string; status: string }>>('aria2.tellWaiting', [0,100000,['gid','status']])])
    if (!Array.isArray(active) || !Array.isArray(reserved)) throw new Error('未能确认辅助任务的实际配额。')
    const targets = [...active, ...reserved.filter(row => row.status === 'waiting' || this.bandwidthAdmissions.has(bindings.get(row.gid)?.id ?? -1) || userOverrides.has(bindings.get(row.gid)?.id ?? -1))]
    if (new Set(targets.map(row => row.gid)).size !== targets.length || targets.some(row => !/^[a-f\d]{16}$/.test(row.gid))) throw new Error('辅助任务的配额标识无效。')
    if (allocation > 0 && targets.length > allocation) throw new Error('当前辅助任务数量需要更高的总限速，无法把零当作暂停配额。')
    const changes: Array<{ gid: string; current: number; next: number }> = []
    for (const row of targets) {
      const options = await rpc.call<Record<string, string>>('aria2.getOption', [row.gid]), raw = options['max-download-limit']
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('未能读取辅助任务的实际限速。')
      const current = Number(raw), userLimit = bindings.get(row.gid)?.userLimit ?? current
      const share = allocation === 0 ? 0 : Math.floor(allocation / targets.length)
      const next = userLimit && share ? Math.min(userLimit, share) : userLimit || share
      changes.push({ gid: row.gid, current, next })
    }
    // Libtorrent excludes local peers from its session rate limit. Per-task
    // limits do apply there; sum these conservative shares inside the one
    // auxiliary allocation, preserving a stricter user limit.
    const numeric = (value: number) => value === 0 ? Infinity : value
    changes.sort((a,b) => Number(numeric(a.next) >= numeric(a.current)) - Number(numeric(b.next) >= numeric(b.current)))
    for (const change of changes) if (change.current !== change.next) {
      await rpc.call('aria2.changeOption', [change.gid, { 'max-download-limit': String(change.next) }])
      if ((await rpc.call<Record<string, string>>('aria2.getOption', [change.gid]))['max-download-limit'] !== String(change.next)) throw new Error('辅助任务尚未确认限速。')
    }
    this.auxiliaryBudgetApplied = true
  }
  private async withBandwidthAdmission<T>(task: WindowsTask, action: () => Promise<T>): Promise<T> {
    if (this.bandwidthAdmissions.has(task.id)) return action()
    return this.withBandwidthOperation(async () => {
      this.bandwidthAdmissions.add(task.id)
      try {
        // Recheck immediately before add/unpause; changing a total limit and
        // admitting a task share this queue so an old limit cannot win later.
        if (this.settings.bandwidthLimitBytesPerSecond > 0) await this.reconcileBandwidth()
        if (task.auxiliary) {
          this.assertAuxiliaryProxy(task)
          await this.auxiliaryDaemon.start()
          if (this.settings.bandwidthLimitBytesPerSecond > 0) await this.reconcileBandwidth()
        }
        return await action()
      } finally { this.bandwidthAdmissions.delete(task.id) }
    })
  }

  private async auxiliaryTransfer(task: WindowsTask): Promise<WindowsAuxiliaryTransfer> {
    if (!task.auxiliary) throw new Error('当前任务不属于辅助协议。')
    let transfer = this.auxiliaryTransfers.get(task.id)
    if (!transfer) {
      transfer = new WindowsAuxiliaryTransfer(task.id, task.auxiliary.generation, validateWindowsAuxiliarySource(task.auxiliary.source),
        join(this.options.stateDirectory, 'auxiliary-tasks', String(task.id), String(task.auxiliary.generation)), this.auxiliaryDaemon,
        this.auxiliaryCredentials.get(task.id), auxiliaryKind(task.auxiliary.source) === 'bittorrent' ? undefined : task.auxiliary.sourceFilename,
        async () => { if (this.settings.bandwidthLimitBytesPerSecond > 0 || this.auxiliaryBudgetApplied) await this.reconcileBandwidth() },
        (): Record<string, string> => {
          const proxy = this.assertAuxiliaryProxy(task)
          return task.auxiliary!.source.kind === 'sftp' ? { 'all-proxy': proxy.kind === 'http' ? proxy.url : '' } : {}
        })
      await transfer.initialize(); this.auxiliaryTransfers.set(task.id, transfer)
    }
    return transfer
  }

  private async createAuxiliary(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = validateWindowsAuxiliarySource(extra.source), key = normalizeCreationKey(extra.creationKey)
    // Credentials are volatile and excluded from both task history and receipt digest.
    const intentDigest = createHash('sha256').update(JSON.stringify({ operation: 'auxiliaryCreate', source, folderPath: extra.folderPath ?? null, autoStart: extra.autoStart !== false })).digest('hex')
    const receipt = this.creationReceipts.get(key), pending = this.pendingCreations.get(key)
    if ((receipt && receipt.intentDigest !== intentDigest) || (pending && pending.intentDigest !== intentDigest)) throw new Error('原创建请求已更改。')
    if (receipt) return this.getCreationReceipt(key)
    if (pending) return pending.result
    const result = Promise.resolve().then(() => this.addAuxiliary({ ...extra, source }, { creationKey: key, intentDigest }))
    this.pendingCreations.set(key, { intentDigest, result })
    try { return await result } finally { if (this.pendingCreations.get(key)?.result === result) this.pendingCreations.delete(key) }
  }

  private async addAuxiliary(extra: Record<string, unknown>, receipt?: Omit<WindowsCreationReceipt, 'taskID'>): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error('下载引擎正在退出。')
    const source = validateWindowsAuxiliarySource(extra.source), kind = auxiliaryKind(source)
    let credentials: WindowsAuxiliaryCredentials | undefined
    if (source.kind === 'sftp' && extra.credentials && typeof extra.credentials === 'object') {
      const input = extra.credentials as Record<string, unknown>
      if (typeof input.username !== 'string' || !input.username || input.username.length > 256 || /[\u0000-\u001f\u007f]/.test(input.username)
          || typeof input.password !== 'string' || !input.password || input.password.length > 4096 || input.password.includes('\0')) throw new Error('SFTP 凭据格式无效。')
      credentials = { username: input.username, password: input.password }
    }
    const url = source.kind === 'torrent' ? `ndm-torrent:${createHash('sha256').update(source.torrentData).digest('hex')}` : source.url
    const name = source.kind === 'sftp' ? basename(new URL(source.url).pathname) : source.kind === 'ed2k' ? decodeURIComponent(source.url.split('|')[2]) : 'BT 文件'
    const filename = sanitizeWindowsFilename(name || '辅助下载')
    this.directoryRuleService ??= this.makeDirectoryRuleService()
    const folderPath = typeof extra.folderPath === 'string' && extra.folderPath.trim() ? extra.folderPath.trim() : resolveDirectoryRule(await this.directoryRuleService.getConfig(), {
      url, filename, fallbackDirectory: this.fallbackDirectory(url, filename), platform: process.platform === 'win32' ? 'win32' : 'posix' }).directory
    if (!isAbsolute(folderPath)) throw new Error('请选择当前系统的绝对目标目录。')
    const task = await this.enqueueStateWrite(async () => {
      if (this.stopped) throw new Error('下载引擎正在退出。')
      const id = this.nextId
      const task: WindowsTask = { id, url, filename, title: filename, source: source.kind === 'sftp' ? new URL(source.url).hostname : kind.toUpperCase(), category: categoryForFilename(filename),
        status: 'paused', folderPath, fileSize: 0, completedBytes: 0, bytesPerSecond: 0, connections: this.settings.maxConnections, bandwidthLimit: 0, createdAt: Date.now(), auxiliary: { source, generation: 1, sourceFilename: filename } }
      const receipts = new Map(this.creationReceipts)
      if (receipt) receipts.set(receipt.creationKey, { ...receipt, taskID: id })
      await this.writeState(this.statePayload([task, ...this.tasks], receipts, id + 1)); this.tasks.unshift(task); this.creationReceipts = receipts; this.nextId = id + 1
      return task
    })
    if (credentials) this.auxiliaryCredentials.set(task.id, credentials)
    await this.withTaskOperation(task.id, async () => {
      try {
        const transfer = await this.auxiliaryTransfer(task)
        const prepared = await transfer.status()
        // Magnet metadata may run, but pause-metadata always gates payload.
        if (kind === 'bittorrent' && prepared.phase === 'metadata' || kind !== 'bittorrent' && extra.autoStart !== false) await this.startTask(task)
        else await this.applyAuxiliarySnapshot(task, prepared)
      } catch (error) { await this.auxiliaryErrorSnapshot(task, error) }
      await this.persist().catch(() => undefined)
    })
    this.broadcast(); return { ok: true, taskID: task.id, task: this.publicTask(task), ...(receipt ? { receipt: { taskID: task.id, taskExists: true } } : {}) }
  }

  private async auxiliaryErrorSnapshot(task: WindowsTask, error?: unknown): Promise<AuxiliarySnapshot> {
    const state = task.auxiliary!
    if (error instanceof WindowsAuxiliaryProxyError) return this.markAuxiliaryProxyPaused(task, error.code)
    const snapshot: AuxiliarySnapshot = { taskID: task.id, generation: state.generation, kind: auxiliaryKind(state.source), phase: 'error', totalBytes: task.fileSize,
      completedBytes: task.completedBytes, downloadSpeed: 0, uploadSpeed: 0, payloadCompleted: false, files: state.snapshot?.files ?? [] }
    state.snapshot = snapshot; task.status = 'error'; task.bytesPerSecond = 0
    task.errorText = state.source.kind === 'sftp' && !this.auxiliaryCredentials.has(task.id) ? '请在协议任务详情中为原任务补充 SFTP 凭据。' : '辅助协议任务暂不可用，请检查任务详情和引擎状态。'
    return snapshot
  }
  private async refreshAuxiliary(task: WindowsTask): Promise<AuxiliarySnapshot> {
    if (!task.auxiliary) throw new Error('当前任务不属于辅助协议。')
    if (task.auxiliary.proxyPauseReason && !task.auxiliary.published && task.auxiliary.snapshot) return task.auxiliary.snapshot
    try {
      if (task.auxiliary.published && task.auxiliary.snapshot) {
        await (await this.auxiliaryTransfer(task)).verifyPublished(task.auxiliary.published)
        return task.auxiliary.snapshot
      }
      const snapshot = await (await this.auxiliaryTransfer(task)).status()
      await this.applyAuxiliarySnapshot(task, snapshot)
      await this.persist(); this.broadcast(); return task.auxiliary.snapshot!
    } catch (error) { const snapshot = await this.auxiliaryErrorSnapshot(task, error); await this.persist().catch(() => undefined); this.broadcast(); return snapshot }
  }
  private async applyAuxiliarySnapshot(task: WindowsTask, snapshot: AuxiliarySnapshot): Promise<void> {
    const state = task.auxiliary!
    if (snapshot.generation !== state.generation || !this.tasks.includes(task)) return
    state.proxyPauseReason = undefined
    state.snapshot = snapshot; task.fileSize = snapshot.totalBytes; task.completedBytes = snapshot.completedBytes; task.bytesPerSecond = snapshot.downloadSpeed
    task.status = ['metadata','checking','downloading','seeding'].includes(snapshot.phase) ? 'downloading' : snapshot.phase === 'error' ? 'error' : 'paused'
    task.errorText = snapshot.phase === 'error' ? formatAria2Error(snapshot.errorCode, '辅助协议下载失败。') : undefined
    if (snapshot.phase === 'complete' && snapshot.payloadCompleted) await this.publishAuxiliary(task)
  }
  private async publishAuxiliary(task: WindowsTask): Promise<void> {
    const transfer = await this.auxiliaryTransfer(task)
    const artifact = await transfer.publish(task.folderPath, task.filename)
    task.auxiliary!.published = artifact; task.folderPath = dirname(artifact.path); task.filename = basename(artifact.path); task.title = task.filename
    task.status = 'complete'; task.bytesPerSecond = 0; task.completedAt ??= Date.now()
    task.auxiliary!.proxyPauseReason = undefined; task.errorText = undefined
    task.auxiliary!.snapshot = { ...task.auxiliary!.snapshot!, phase: 'complete', payloadCompleted: true, errorCode: undefined }
  }
  private async controlAuxiliary(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = this.taskById(Number(extra.taskID)), state = task.auxiliary
    if (!state || extra.generation !== state.generation) throw new Error('辅助任务代次已变化，请刷新。')
    const transfer = await this.auxiliaryTransfer(task)
    if (op === 'auxiliaryAuthenticate') {
      if (state.source.kind !== 'sftp' || !extra.credentials || typeof extra.credentials !== 'object') throw new Error('当前任务不接受认证更新。')
      const input = extra.credentials as Record<string, unknown>
      if (typeof input.username !== 'string' || !input.username || input.username.length > 256 || /[\u0000-\u001f\u007f]/.test(input.username)
          || typeof input.password !== 'string' || !input.password || input.password.length > 4096 || input.password.includes('\0')) throw new Error('SFTP 凭据格式无效。')
      const credentials = { username: input.username, password: input.password }
      this.auxiliaryCredentials.set(task.id, credentials); await transfer.authenticate(credentials)
      if (extra.autoStart === true) await this.startTask(task)
      else await this.applyAuxiliarySnapshot(task, await transfer.status())
    } else if (op === 'auxiliarySelectFiles') {
      if (!Array.isArray(extra.indices) || extra.indices.some(index => !Number.isSafeInteger(index))) throw new Error('文件选择无效。')
      await this.applyAuxiliarySnapshot(task, await transfer.selectFiles(extra.indices as number[]))
      if (extra.autoStart === true) await this.startTask(task)
    } else {
      const snapshot = state.proxyPauseReason && state.snapshot?.payloadCompleted ? state.snapshot : await transfer.pause()
      if (!state.proxyPauseReason) await this.applyAuxiliarySnapshot(task, snapshot)
      if (!snapshot.payloadCompleted) throw new Error('文件内容尚未完成，已暂停但未交付。')
      await this.publishAuxiliary(task)
    }
    await this.persist(); this.broadcast(); return { ok: true, snapshot: state.snapshot }
  }

  private async startTask(task: WindowsTask, fresh = false): Promise<void> {
    return this.withBandwidthAdmission(task, () => this.startTaskUnlocked(task, fresh))
  }

  private async startTaskUnlocked(task: WindowsTask, fresh = false): Promise<void> {
    if (task.auxiliary) { await this.applyAuxiliarySnapshot(task, await (await this.auxiliaryTransfer(task)).start()); return }
    const generation = (task.generation ?? 0) + 1
    task.generation = generation
    if (this.isMergedMediaTask(task)) {
      await this.startMergedMedia(task, fresh, generation)
      return
    }
    if (task.pageURL && task.mediaFormatID && !task.transferURL) {
      const info = await this.inspectMedia(task.pageURL, task.mediaFormatID)
      this.assertCurrentGeneration(task, generation)
      const selected = info.requested_downloads?.[0] ?? info
      if (!selected.url) throw new Error('无法刷新媒体下载地址')
      task.transferURL = selected.url
      task.headers = Object.entries(selected.http_headers ?? info.http_headers ?? {}).map(([name, value]) => `${name}: ${value}`)
    }
    // Headers do not survive persistence by design; a resumed task that was
    // authorized through a browser needs a fresh export before this attempt.
    if (!task.headers?.length) await this.refreshCookieSession(task)
    const mirrorURLs = validateMirrorURLs(task.transferURL ?? task.url, task.mirrorURLs, task)
    await mkdir(task.folderPath, { recursive: true })
    this.assertCurrentGeneration(task, generation)
    const gid = await this.rpc.call<string>('addUri', [[task.transferURL ?? task.url, ...mirrorURLs], this.taskOptions(task)])
    if (this.stopped || (task.generation ?? 0) !== generation) {
      await this.rpc.call('forceRemove', [gid]).catch(() => undefined)
      await this.rpc.call('removeDownloadResult', [gid]).catch(() => undefined)
      throw new Error('下载任务已被较新的操作替代')
    }
    task.gid = gid
    task.status = 'downloading'
    task.errorText = undefined
    task.startAt = undefined
  }

  private assertCurrentGeneration(task: WindowsTask, generation: number): void {
    if (this.stopped || (task.generation ?? 0) !== generation) {
      throw new Error('下载任务已被较新的操作替代')
    }
  }

  private fallbackDirectory(url: string, filename?: string): string {
    if (!this.settings.useCategoryFolders) return this.settings.downloadDirectory
    const category = categoryForFilename(filename || nameFromDownloadUrl(url, 0))
    return join(this.settings.downloadDirectory, category[0].toUpperCase() + category.slice(1))
  }

  private makeDirectoryRuleService(): DirectoryRulesService {
    return new DirectoryRulesService({
      statePath: this.options.directoryRulesPath ?? join(this.options.stateDirectory, 'directory-rules.json'),
      chooseDirectory: async () => null,
      resolveFallbackDirectory: async sample => this.fallbackDirectory(sample.url, sample.filename)
    })
  }

  private async add(
    extra: Record<string, unknown>, receipt?: Omit<WindowsCreationReceipt, 'taskID'>, category?: WindowsCategory
  ): Promise<Record<string, unknown>> {
    // Media inspection can finish well after the user quits. Its uncommitted
    // operation must not add a task behind the final shutdown snapshot.
    if (this.stopped) throw new Error('下载引擎正在退出，请稍后重试')
    const url = String(extra.url ?? '').trim()
    if (!isSupportedDownloadUrl(url)) throw new Error('支持 HTTP、HTTPS、FTP、磁力链和 .torrent 链接')
    const mirrorURLs = validateMirrorURLs(url, extra.mirrors, {
      headers: Array.isArray(extra.headers) ? extra.headers.map(String) : undefined,
      pageURL: typeof extra.pageURL === 'string' ? extra.pageURL : undefined,
      cookieBrowser: typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined
    })
    if (mirrorURLs.length && (extra.mediaFormatID || extra.transferURL || extra.method && extra.method !== 'GET' || extra.postData || extra.body)) {
      throw new Error('镜像任务只支持普通 GET 文件下载。')
    }
    const explicitDirectory = typeof extra.folderPath === 'string' ? extra.folderPath.trim() : ''
    const requestedFilename = String(extra.filename ?? '').trim()
    this.directoryRuleService ??= this.makeDirectoryRuleService()
    const folderPath = explicitDirectory || resolveDirectoryRule(await this.directoryRuleService.getConfig(), {
      url, filename: requestedFilename, fallbackDirectory: this.fallbackDirectory(url, requestedFilename),
      platform: process.platform === 'win32' ? 'win32' : 'posix'
    }).directory
    const task = await this.enqueueStateWrite(async () => {
      if (this.stopped) throw new Error('下载引擎正在退出。')
      const id = this.nextId
      const requestedName = String(extra.filename ?? '').trim()
      const filename = sanitizeWindowsFilename(requestedName || nameFromDownloadUrl(url, id))
      const task: WindowsTask = {
        id,
        url,
        mirrorURLs: mirrorURLs.length ? mirrorURLs : undefined,
        transferURL: typeof extra.transferURL === 'string' ? extra.transferURL : undefined,
        pageURL: typeof extra.pageURL === 'string' ? extra.pageURL : undefined,
        thumbnailURL: typeof extra.thumbnailURL === 'string' ? extra.thumbnailURL : undefined,
        filename,
        title: String(extra.pageTitle ?? '').trim() || filename,
        source: sourceFromDownloadUrl(url),
        category: category ?? (url.startsWith('magnet:') ? 'misc' : categoryForFilename(filename)),
        status: 'paused',
        folderPath,
        fileSize: Math.max(0, Number(extra.fileSize) || 0),
        completedBytes: 0,
        bytesPerSecond: 0,
        connections: clampConnections(extra.connections ?? this.settings.maxConnections),
        bandwidthLimit: 0,
        createdAt: Date.now(),
        headers: Array.isArray(extra.headers) ? extra.headers.map(String) : undefined,
        cookieBrowser: typeof extra.cookieBrowser === 'string' ? extra.cookieBrowser : undefined,
        mediaFormatID: typeof extra.mediaFormatID === 'string' ? extra.mediaFormatID : undefined,
        mediaComponentBytes: Array.isArray(extra.mediaComponentBytes)
          ? extra.mediaComponentBytes.map(Number).filter(value => Number.isFinite(value) && value > 0)
          : undefined,
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
      const receipts = new Map(this.creationReceipts)
      if (receipt) receipts.set(receipt.creationKey, { ...receipt, taskID: id })
      // Neither a task nor its receipt is visible until their single atomic
      // snapshot commits. A write failure leaves no in-memory phantom task.
      await this.writeState(this.statePayload([task, ...this.tasks], receipts, id + 1))
      this.tasks.unshift(task)
      this.creationReceipts = receipts
      this.nextId = id + 1
      return task
    })
    let startError: unknown
    await this.withTaskOperation(task.id, async () => {
      if (extra.autoStart !== false && !this.stopped) {
        try {
          await this.startTask(task)
        } catch (error) {
          startError = error
          task.status = this.stopped ? 'paused' : 'error'
          task.bytesPerSecond = 0
          task.errorText = this.stopped ? undefined : error instanceof Error ? error.message : String(error)
        }
        // Creation already committed. Even a later status-write failure must
        // return that task, so a lost start acknowledgement cannot create it twice.
        if (receipt) await this.persist().catch(() => undefined)
        else await this.persist()
      }
    })
    this.broadcast()
    // Keep legacy/Relay callers' existing start-failure contract. Draft callers
    // have a durable key and must learn that creation succeeded despite it.
    if (startError && !receipt) throw startError
    return { ok: true, task: this.publicTask(task),
      ...(receipt ? { receipt: { taskID: task.id, taskExists: true } } : {}) }
  }

  private async startMergedMedia(task: WindowsTask, fresh: boolean, generation: number): Promise<void> {
    if (!existsSync(this.options.ytDlpPath)) throw new Error('Windows yt-dlp.exe 未打包')
    if (!existsSync(this.options.ffmpegPath)) throw new Error('Windows ffmpeg.exe 未打包，无法合并视频与音频')
    if (this.mediaRuns.has(task.id)) return
    await mkdir(task.folderPath, { recursive: true })
    this.assertCurrentGeneration(task, generation)
    const outputPath = this.safeTaskFile(task)
    if (!outputPath) throw new Error('媒体输出路径无效')
    const temporaryDirectory = this.mediaTemporaryDirectory(task)
    if (fresh) await rm(temporaryDirectory, { recursive: true, force: true })
    this.assertCurrentGeneration(task, generation)
    await mkdir(temporaryDirectory, { recursive: true })
    this.assertCurrentGeneration(task, generation)
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
      bandwidthLimit,
      temporaryDirectory,
      forceOverwrite: fresh
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
    const downloaded = Math.max(previous?.downloadedBytes ?? 0, report.downloadedBytes)
    components.set(report.componentID, {
      ...report,
      downloadedBytes: downloaded,
      // HLS revises its estimates as fragments arrive. Finished reports carry
      // the actual byte count; an earlier overestimate must not survive them.
      totalBytes: report.status === 'finished'
        ? downloaded
        : Math.max(downloaded, report.totalBytes || previous?.totalBytes || 0),
      bytesPerSecond: report.status === 'finished' ? 0 : report.bytesPerSecond
    })
    this.mediaProgress.set(task.id, components)
    const totals = Array.from(components.values())
    const completed = totals.reduce((sum, item) => sum + item.downloadedBytes, 0)
    let total = totals.reduce((sum, item) => sum + item.totalBytes, 0)
    const estimates = task.mediaComponentBytes ?? []
    if (estimates.length > 0) {
      // Reserve pending audio without retaining the probe's inflated video
      // estimate after the downloader has a better measurement.
      total += estimates.slice(totals.length).reduce((sum, bytes) => sum + bytes, 0)
    } else if (totals.length < 2 && requiresMediaMerge(task.mediaFormatID ?? '')) {
      // Older saved tasks do not have per-stream estimates.
      total = Math.max(task.fileSize, total)
    }
    task.completedBytes = completed
    task.fileSize = Math.max(completed, total)
    task.bytesPerSecond = report.status === 'finished' ? 0 : report.bytesPerSecond
    task.status = 'downloading'
    void this.persist()
    this.broadcast()
  }

  private async finishMediaRun(taskID: number, run: MediaRun, code: number | null): Promise<void> {
    try {
      if (this.mediaRuns.get(taskID) !== run) return
      const task = this.tasks.find((candidate) => candidate.id === taskID)
      if (!task || run.stopping) return
      task.bytesPerSecond = 0
      if (code === 0) {
        const path = run.destinationPath && dirname(resolve(run.destinationPath)) === resolve(task.folderPath)
          ? run.destinationPath
          : this.safeTaskFile(task)
        const size = path ? (await stat(path).catch(() => null))?.size ?? 0 : 0
        if (run.stopping || this.mediaRuns.get(taskID) !== run) return
        if (size <= 0) throw new Error('媒体合并完成但没有找到输出文件')

        // Cleanup can yield to restart/remove. Keep the run registered and
        // re-check ownership before publishing completion.
        await this.removeTaskArtifacts(task, false)
        await this.removeMediaTemporaryDirectory(task)
        if (run.stopping || this.mediaRuns.get(taskID) !== run) return

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
      if (task && !run.stopping && this.mediaRuns.get(taskID) === run) {
        task.status = 'error'
        task.bytesPerSecond = 0
        task.errorText = error instanceof Error ? error.message : String(error)
        await this.persist()
        this.broadcast()
      }
    } finally {
      if (this.mediaRuns.get(taskID) === run) {
        this.mediaRuns.delete(taskID)
        this.mediaProgress.delete(taskID)
      }
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
    let closed = await Promise.race([
      run.done.then(() => true),
      delay(2_000).then(() => false)
    ])
    if (!closed && run.child.exitCode == null) {
      this.terminateMediaRun(run, true)
      closed = await Promise.race([
        run.done.then(() => true),
        delay(1_000).then(() => false)
      ])
    }
    if (!closed && run.child.exitCode == null) {
      throw new Error('媒体下载进程未能停止；为避免并发写入，未启动替代任务')
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
    if (task.auxiliary) { await this.applyAuxiliarySnapshot(task, await (await this.auxiliaryTransfer(task)).pause()); await this.persist(); this.broadcast(); return { ok: true } }
    const gid = task.gid
    task.generation = (task.generation ?? 0) + 1
    const applying = this.ariaStatusApplications.get(task.id)
    if (applying) await applying.catch(() => undefined)
    await this.stopMediaTask(task)
    if (task.status === 'complete') return { ok: true }
    if (gid && (task.status === 'downloading' || task.status === 'waiting')) {
      await this.rpc.call('forcePause', [gid])
    }
    task.status = 'paused'
    task.bytesPerSecond = 0
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async resume(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    if (task.auxiliary) {
      if (task.status === 'complete') return this.restart(id)
      try { await this.startTask(task) }
      catch (error) {
        if (error instanceof WindowsAuxiliaryProxyError) this.markAuxiliaryProxyPaused(task, error.code)
        else { task.status = 'error'; task.errorText = '辅助下载暂未开始，请检查协议任务详情。' }
        await this.persist(); this.broadcast(); throw error
      }
      await this.persist(); this.broadcast(); return { ok: true }
    }
    if (task.status === 'complete') return this.restart(id)
    if (task.gid) {
      await this.withBandwidthAdmission(task, async () => {
        try {
          await this.rpc.call('unpause', [task.gid]); task.status = 'downloading'
        } catch {
          task.gid = undefined
          await this.startTask(task)
        }
      })
    } else {
      await this.startTask(task)
    }
    await this.persist()
    this.broadcast()
    return { ok: true }
  }

  private async pauseMany(tasks: WindowsTask[]): Promise<Record<string, unknown>> {
    for (const task of tasks) {
      await this.withTaskOperation(task.id, () => this.pause(task.id))
    }
    return { ok: true }
  }

  private async resumeMany(tasks: WindowsTask[]): Promise<Record<string, unknown>> {
    for (const task of [...tasks].sort((a, b) => (a.queueRank ?? Number.MAX_SAFE_INTEGER) - (b.queueRank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)) {
      await this.withTaskOperation(task.id, () => this.resume(task.id))
    }
    return { ok: true }
  }

  private async waitingQueue(): Promise<{ gids: string[]; tasks: WindowsTask[] }> {
    const waiting = await this.rpc.call<Array<{ gid: string; status: string }>>('tellWaiting', [0, 100_000, ['gid', 'status']])
    if (!Array.isArray(waiting) || waiting.some(row => !row || typeof row.gid !== 'string' || typeof row.status !== 'string')) throw new Error('未能读取当前队列。')
    const gids = waiting.map(row => row.gid)
    const tasks = waiting.filter(row => row.status === 'waiting').flatMap(row => {
      const task = this.tasks.find(task => task.gid === row.gid && !task.startAt && !this.mediaRuns.has(task.id))
      return task ? [task] : []
    })
    return { gids, tasks }
  }

  private async moveQueuedTask(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = extra.taskID
    if (!Number.isSafeInteger(id)) throw new Error('任务编号无效。')
    const operation = this.queueOperationTail.catch(() => undefined).then(() => this.withTaskOperation(Number(id), async () => {
      const queue = await this.waitingQueue(), ids = queue.tasks.map(task => task.id)
      const beforeID = extra.beforeTaskID == null ? null : extra.beforeTaskID
      if (!Array.isArray(extra.expectedIDs) || JSON.stringify(ids) !== JSON.stringify(extra.expectedIDs)
          || !ids.includes(Number(id)) || beforeID === id || (beforeID !== null && (!Number.isSafeInteger(beforeID) || !ids.includes(Number(beforeID))))) {
        throw new Error('队列已变化，请查看最新顺序后重试。')
      }
      const task = this.taskById(Number(id)), gid = task.gid!
      const others = queue.gids.filter(candidate => candidate !== gid)
      const beforeGID = beforeID === null ? undefined : queue.tasks.find(task => task.id === beforeID)?.gid
      const position = beforeGID ? others.indexOf(beforeGID) : others.length
      await this.rpc.call('changePosition', [gid, position, 'POS_SET'])
      const confirmed = await this.waitingQueue()
      const ranks = new Map(confirmed.tasks.map((task, index) => [task.id, index]))
      await this.enqueueStateWrite(async () => {
        const updated = this.tasks.map(task => ({ ...task, queueRank: ranks.get(task.id) }))
        await this.writeState(this.statePayload(updated))
        for (const current of this.tasks) current.queueRank = ranks.get(current.id)
      })
      this.broadcast()
      return { ok: true, tasks: confirmed.tasks.map(task => this.publicTask(task)) }
    }))
    this.queueOperationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async stopTask(task: WindowsTask): Promise<void> {
    if (task.auxiliary) { await (await this.auxiliaryTransfer(task)).cancel(); return }
    // Invalidate any tellStatus query synchronously, before the first await.
    // A status application that already began is awaited before this task can
    // clean or recreate files with the same names.
    const gid = task.gid
    const generation = (task.generation ?? 0) + 1
    task.generation = generation
    task.gid = undefined
    const applying = this.ariaStatusApplications.get(task.id)
    if (applying) await applying.catch(() => undefined)

    await this.stopMediaTask(task)
    if (!gid) return
    const mayStillWrite = task.status === 'downloading'
      || task.status === 'waiting'
      || task.status === 'paused'
    if (mayStillWrite) {
      try {
        await this.rpc.call('forceRemove', [gid])
      } catch (error) {
        // Do not start a replacement while the old writer may still be alive.
        if ((task.generation ?? 0) === generation && !task.gid) task.gid = gid
        throw error
      }
    }
    await this.rpc.call('removeDownloadResult', [gid]).catch((error) => {
      console.warn(`[windowsEngine] Failed to remove aria2 result ${gid}:`, error)
    })
  }

  private safeTaskFile(task: WindowsTask): string | null {
    const folder = resolve(task.folderPath)
    const path = resolve(folder, task.filename)
    return dirname(path) === folder ? path : null
  }

  private mediaTemporaryDirectory(task: WindowsTask): string {
    return join(this.options.stateDirectory, 'media', String(task.id))
  }

  private async removeMediaTemporaryDirectory(task: WindowsTask, strict = false): Promise<void> {
    try {
      await rm(this.mediaTemporaryDirectory(task), { recursive: true, force: true })
    } catch (error: any) {
      console.warn(`[windowsEngine] Failed to remove media staging for task ${task.id}:`, error)
      if (strict) throw error
    }
  }

  private async removeTaskArtifacts(task: WindowsTask, includeFinal: boolean, strict = false): Promise<void> {
    const path = this.safeTaskFile(task)
    if (!path) return
    const filename = basename(path)

    // The destination is shared with user files. Delete only paths whose exact
    // names are owned by this task; yt-dlp intermediates live in app-owned staging.
    for (const name of ownedTaskArtifactNames(filename, includeFinal)) {
      try {
        await unlink(join(task.folderPath, name))
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          console.warn(`[windowsEngine] Failed to unlink artifact ${name}:`, error)
          if (strict) throw error
        }
      }
    }
  }

  private async restart(id: number): Promise<Record<string, unknown>> {
    const task = this.taskById(id)
    if (task.auxiliary) {
      await (await this.auxiliaryTransfer(task)).cancel()
      // Re-download owns a new work generation; previous files remain intact.
      task.auxiliary = { source: task.auxiliary.source, generation: task.auxiliary.generation + 1, sourceFilename: task.auxiliary.sourceFilename }
      this.auxiliaryTransfers.delete(id); task.status = 'paused'; task.completedBytes = 0; task.fileSize = 0; task.completedAt = undefined; task.errorText = undefined
      await this.persist()
      await this.startTask(task)
      await this.persist(); this.broadcast(); return { ok: true, task: this.publicTask(task) }
    }
    await this.stopTask(task)
    await this.removeTaskArtifacts(task, true, true)
    await this.removeMediaTemporaryDirectory(task, true)
    task.completedBytes = 0
    task.fileSize = 0
    task.completedAt = undefined
    task.errorText = undefined
    if (task.pageURL && task.mediaFormatID) {
      task.transferURL = undefined
      task.headers = undefined
    }
    await this.startTask(task, true)
    await this.persist()
    this.broadcast()
    return { ok: true, task: this.publicTask(task) }
  }

  private async renew(id: number, url: string): Promise<Record<string, unknown>> {
    if (this.taskById(id).auxiliary) throw new Error('辅助协议任务不能替换为普通下载链接。')
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
    if (task.auxiliary) {
      const bytes = Math.max(0, Number(value) || 0)
      if (!Number.isSafeInteger(bytes)) throw new Error('限速值无效。')
      await this.withBandwidthOperation(async () => {
        const transfer = await this.auxiliaryTransfer(task)
        await this.reconcileBandwidth(this.settings.bandwidthLimitBytesPerSecond, new Map([[task.id, bytes]]))
        await transfer.recordBandwidth(bytes)
        task.bandwidthLimit = bytes
      })
      await this.persist(); this.broadcast(); return { ok: true }
    }
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
    if (task.auxiliary) {
      const transfer = await this.auxiliaryTransfer(task)
      await transfer.cancel()
      const artifact = task.auxiliary.published ?? await transfer.published()
      if (deleteFile && artifact) await transfer.deletePublished(artifact)
      await this.enqueueStateWrite(async () => { const remaining = this.tasks.filter(candidate => candidate.id !== id); await this.writeState(this.statePayload(remaining)); this.tasks = remaining })
      await transfer.cleanup().catch(() => undefined)
      this.auxiliaryTransfers.delete(id); this.auxiliaryCredentials.delete(id); this.broadcast(); return { ok: true }
    }
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
    // Resume data is app-owned and has no purpose after its task record is gone.
    await this.removeMediaTemporaryDirectory(task)
    await this.enqueueStateWrite(async () => {
      const remaining = this.tasks.filter((candidate) => candidate.id !== id)
      await this.writeState(this.statePayload(remaining))
      this.tasks = remaining
    })
    this.broadcast()
    return { ok: true }
  }

  private async removeMany(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(extra.taskIDs) ? extra.taskIDs.map(Number).filter(Number.isFinite) : []
    for (const id of ids) {
      await this.withTaskOperation(id, () => this.remove(id, extra.deleteFile === true))
    }
    return { ok: true, removed: ids.length }
  }

  private async restartMany(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(extra.taskIDs) ? extra.taskIDs.map(Number).filter(Number.isFinite) : []
    let count = 0
    for (const id of ids) {
      try {
        await this.withTaskOperation(id, () => this.restart(id))
        count += 1
      } catch {
        // A missing row must not abort the whole cleanup batch.
      }
    }
    return { ok: true, count }
  }

  private assertAuxiliaryProxy(task: WindowsTask) {
    if (this.auxiliaryProxyUnavailable) throw new WindowsAuxiliaryProxyError('proxyUnavailable')
    const proxy = auxiliaryProxyPlan(this.settings)
    assertAuxiliaryProxyProtocol(task.auxiliary!.source.kind, proxy)
    return proxy
  }

  private markAuxiliaryProxyPaused(task: WindowsTask, code: AuxiliaryProxyCode): AuxiliarySnapshot {
    const state = task.auxiliary!
    const snapshot: AuxiliarySnapshot = { ...state.snapshot, taskID: task.id, generation: state.generation, kind: auxiliaryKind(state.source),
      phase: 'paused', totalBytes: task.fileSize, completedBytes: task.completedBytes, downloadSpeed: 0, uploadSpeed: 0,
      payloadCompleted: state.snapshot?.payloadCompleted ?? false, files: state.snapshot?.files ?? [], errorCode: code }
    state.proxyPauseReason = code; state.snapshot = snapshot; task.status = 'paused'; task.bytesPerSecond = 0
    if (code === 'proxyUnavailable' && this.auxiliaryProxyUnavailable) { task.status = 'error'; snapshot.phase = 'error' }
    task.startAt = undefined; task.errorText = AUXILIARY_ERROR_MESSAGES[code]
    return snapshot
  }

  private async suspendAuxiliaryForProxy(): Promise<void> {
    // request()/poll() hold the outer read gate. updateSettings owns the write
    // gate, so no status replay or late unpause can revive the old connection.
    const tasks = this.tasks.filter(task => task.auxiliary && !task.auxiliary.published)
    try {
      if (!this.auxiliaryDaemon.suspend) throw new WindowsAuxiliaryProxyError('proxyUnavailable')
      await this.auxiliaryDaemon.suspend()
      for (const task of tasks) {
        await (await this.auxiliaryTransfer(task)).recordProxyPause(task.auxiliary!.snapshot)
        this.markAuxiliaryProxyPaused(task, 'proxyChanged')
      }
      this.auxiliaryProxyUnavailable = false
    } catch {
      this.auxiliaryProxyUnavailable = true
      for (const task of tasks) {
        this.markAuxiliaryProxyPaused(task, 'proxyUnavailable')
        // No false stopped claim when termination could not be confirmed.
        task.status = 'error'; task.auxiliary!.snapshot!.phase = 'error'
      }
      await this.persist().catch(() => undefined); this.broadcast()
      throw new WindowsAuxiliaryProxyError('proxyUnavailable')
    }
  }

  private async updateSettings(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const previous = this.settings, next = { ...previous }
    for (const key of ['httpProxyPort', 'socksProxyPort'] as const) {
      if (extra[key] == null) continue
      const port = Number(extra[key])
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('代理端口必须是 1–65535 之间的整数')
      next[key] = port
    }
    for (const key of ['useCategoryFolders', 'downloadAllAtOnce', 'smartConnections', 'httpProxyEnabled', 'socksProxyEnabled'] as const) {
      if (typeof extra[key] === 'boolean') next[key] = extra[key]
    }
    for (const key of ['httpProxyHost', 'socksProxyHost'] as const) {
      if (typeof extra[key] === 'string') next[key] = extra[key].trim()
    }
    const newProxy = auxiliaryProxyPlan(next)
    let oldProxyURL: string | undefined
    try { oldProxyURL = auxiliaryProxyPlan(previous).url } catch { /* Allow repair of invalid legacy settings. */ }
    const proxyChanged = newProxy.url !== oldProxyURL || this.auxiliaryProxyUnavailable
    if (typeof extra.downloadDirectory === 'string' && extra.downloadDirectory.trim()) {
      next.downloadDirectory = extra.downloadDirectory.trim()
      await mkdir(next.downloadDirectory, { recursive: true })
    }
    if (extra.maxConnections != null) next.maxConnections = clampConnections(extra.maxConnections)
    if (extra.bandwidthLimitBytesPerSecond != null) {
      const limit = Number(extra.bandwidthLimitBytesPerSecond)
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('限速必须是非负整数字节数。')
      await this.withBandwidthOperation(() => this.reconcileBandwidth(limit))
      next.bandwidthLimitBytesPerSecond = limit
    }
    if (proxyChanged) await this.suspendAuxiliaryForProxy()
    this.settings = next
    try { await this.persist() }
    catch (error) { this.settings = previous; throw error }
    this.broadcast()
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
      execFile(this.options.ytDlpPath, ['--ignore-config', ...args], {
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
    if (formats.length === 0 && info.url && isPlayableMediaInfo(info)) {
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

  private async addMedia(
    extra: Record<string, unknown>, receipt?: Omit<WindowsCreationReceipt, 'taskID'>
  ): Promise<Record<string, unknown>> {
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
      mediaComponentBytes: container === 'compactMKV' ? tier.compactComponentBytes : tier.componentBytes,
      mediaOptions: {
        container,
        subtitleLanguage: typeof extra.subtitleLanguage === 'string' ? extra.subtitleLanguage : undefined
      },
      mediaCookieBrowser: cookieBrowser,
      fileSize: estimatedBytes,
      autoStart: true
    }, receipt, 'video')
    return { ...reply, tasks: [reply.task] }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) return
    this.pollInFlight = true
    try { await this.proxyOperations.run(false, () => this.pollUnlocked()) }
    finally { this.pollInFlight = false }
  }

  private async pollUnlocked(): Promise<void> {
    if (this.stopped) return
    {
      let changed = false
      const scheduled = this.tasks.filter((task) => task.startAt && task.startAt <= Date.now())
      for (const task of scheduled) {
        task.startAt = undefined
        await this.withTaskOperation(task.id, () => this.resume(task.id)).catch((error) => {
          task.status = 'error'
          task.errorText = error instanceof Error ? error.message : String(error)
        })
        changed = true
      }
      for (const task of this.tasks) {
        if (task.auxiliary) {
          if (task.status !== 'complete' && (task.status === 'downloading' || task.status === 'waiting')) {
            await this.withTaskOperation(task.id, async () => { await this.refreshAuxiliary(task) }).catch(() => undefined); changed = true
          }
          continue
        }
        if (!task.gid || (task.status !== 'downloading' && task.status !== 'waiting')) continue
        try {
          const queryGid = task.gid
          const queryGen = task.generation ?? 0
          let status = await this.rpc.call<Aria2Status>('tellStatus', [queryGid])
          if (task.gid !== queryGid || (task.generation ?? 0) !== queryGen) continue
          if (status.followedBy?.[0]) {
            const nextGid = status.followedBy[0]
            task.gid = nextGid
            status = await this.rpc.call<Aria2Status>('tellStatus', [nextGid])
            if (task.gid !== nextGid || (task.generation ?? 0) !== queryGen) continue
          }

          const application = this.applyAriaStatus(task, status)
          this.ariaStatusApplications.set(task.id, application)
          try {
            await application
          } finally {
            if (this.ariaStatusApplications.get(task.id) === application) {
              this.ariaStatusApplications.delete(task.id)
            }
          }
          changed = true
        } catch {
          // A single transient RPC miss must not turn a valid download red.
        }
      }
      if (this.settings.bandwidthLimitBytesPerSecond > 0) await this.withBandwidthOperation(() => this.reconcileBandwidth()).catch(() => undefined)
      if (changed) {
        await this.persist()
        this.broadcast()
      }
    }
  }

  private async applyAriaStatus(task: WindowsTask, status: Aria2Status): Promise<void> {
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
        await this.removeTaskArtifacts(task, false)
        break
      case 'error':
        task.status = 'error'
        task.bytesPerSecond = 0
        task.errorText = formatAria2Error(status.errorCode, status.errorMessage)
        break
      case 'removed':
        task.status = 'error'
        task.bytesPerSecond = 0
        // Preserve the existing removed-state behavior without interpreting a
        // removal code as a new download failure category.
        task.errorText = sanitizeDownloadError(status.errorMessage) || 'aria2 下载失败'
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
      effectiveBandwidthLimit: task.bandwidthLimit || this.settings.bandwidthLimitBytesPerSecond || 0,
      activityAt: task.completedAt ?? task.createdAt,
      startAt: task.startAt,
      segments,
      errorText: sanitizeDownloadError(task.errorText),
      completedAt: task.completedAt,
      folderPath: task.folderPath,
      mediaOptions: task.mediaOptions,
      ...(task.auxiliary ? { linkType: auxiliaryKind(task.auxiliary.source), auxiliary: { kind: auxiliaryKind(task.auxiliary.source), generation: task.auxiliary.generation,
        phase: task.auxiliary.snapshot?.phase ?? 'paused', payloadCompleted: task.auxiliary.snapshot?.payloadCompleted ?? false } } : {})
    }
  }

  private snapshot(): Record<string, unknown>[] {
    return this.tasks.map((task) => this.publicTask(task))
  }

  private broadcast(): void {
    this.callbacks.onEvent({ op: 'snapshot', tasks: this.snapshot() })
  }
}
