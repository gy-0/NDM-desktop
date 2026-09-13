import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { validateAuxiliaryCreate, readAuxiliarySnapshot, type AuxiliarySnapshot, type AuxiliaryCreateRequest, type AuxiliaryFile } from '../../shared/auxiliaryTransfer'
import { writeAtomicWindowsState } from './creationReceipts'
import { sanitizeWindowsFilename } from './engineCore'
import { auxiliaryDelay, type WindowsAuxiliaryDaemonProvider } from './auxiliaryDaemon'
import { WindowsAuxiliaryRPCError, type WindowsAuxiliaryRPC } from './auxiliaryRpc'

export type WindowsAuxiliarySource = Exclude<AuxiliaryCreateRequest['source'], { kind: 'torrent' }> | { kind: 'torrent'; torrentData: string }
export type WindowsAuxiliaryCredentials = NonNullable<AuxiliaryCreateRequest['credentials']>
type FileIdentity = { device: number; inode: number; size: number }
export type PublishedAuxiliaryArtifact = FileIdentity & { path: string; directory: boolean; files?: Array<FileIdentity & { relativePath: string }> }
export interface WindowsAuxiliaryTaskState { source: WindowsAuxiliarySource; generation: number; sourceFilename?: string; snapshot?: AuxiliarySnapshot; published?: PublishedAuxiliaryArtifact }
type Journal = { version: 1; taskID: number; generation: number; gid: string; sourceHash: string; workIdentity: FileIdentity; filesIdentity: FileIdentity; payloadVerified?: boolean; selectedFiles?: number[]; bandwidthLimit: number; requestedRunning: boolean; removed: boolean; files: AuxiliaryFile[]; published?: PublishedAuxiliaryArtifact }
const identity = (info: { dev: number; ino: number; size: number }): FileIdentity => ({ device: info.dev, inode: info.ino, size: info.size })
const validIdentity = (value: unknown): value is FileIdentity => !!value && typeof value === 'object' && ['device', 'inode', 'size'].every(key => Number.isSafeInteger((value as any)[key]) && (value as any)[key] >= 0)
export function validPublishedArtifact(value: unknown): value is PublishedAuxiliaryArtifact {
  const item = value as PublishedAuxiliaryArtifact
  return validIdentity(value) && typeof item.path === 'string' && isAbsolute(item.path) && typeof item.directory === 'boolean'
    && (!item.directory || Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 100000 && item.files.every(file => validIdentity(file) && typeof file.relativePath === 'string'))
}
export const auxiliaryKind = (source: WindowsAuxiliarySource) => source.kind === 'magnet' || source.kind === 'torrent' ? 'bittorrent' as const : source.kind
export function validateWindowsAuxiliarySource(value: unknown): WindowsAuxiliarySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('辅助来源无效。')
  const raw = value as Record<string, unknown>
  if (raw.kind === 'torrent') {
    if (Object.keys(raw).some(key => !['kind', 'torrentData'].includes(key)) || typeof raw.torrentData !== 'string' || raw.torrentData.length > 12 * 1024 * 1024 || !/^[A-Za-z\d+/]*={0,2}$/.test(raw.torrentData)) throw new Error('种子数据无效。')
    const data = Buffer.from(raw.torrentData, 'base64')
    if (!data.length || data.length > 8 * 1024 * 1024 || data.toString('base64') !== raw.torrentData) throw new Error('种子数据无效。')
    return { kind: 'torrent', torrentData: raw.torrentData }
  }
  const source = validateAuxiliaryCreate({ creationKey: randomUUID(), source: raw, autoStart: false,
    ...(raw.kind === 'sftp' ? { credentials: { username: 'validation', password: 'validation' } } : {}) }, process.platform === 'win32' ? 'win32' : 'posix').source
  if (source.kind === 'torrent') throw new Error('种子来源无效。')
  return source
}
const integer = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new WindowsAuxiliaryRPCError('invalidResponse')
  return Number(value)
}
const bool = (value: unknown): boolean => { if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; throw new WindowsAuxiliaryRPCError('invalidResponse') }

/** Refuse symlink traversal before inspecting, copying, or deleting artifacts. */
export async function safeAuxiliaryPath(root: string, file: string, allowMissing = true): Promise<string> {
  if (!file || file.length > 4096 || /[\\:\u0000-\u001f\u007f-\u009f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || sanitizeWindowsFilename(part) !== part)) throw new Error('辅助引擎文件路径不安全。')
  const base = resolve(root), path = resolve(base, file)
  if (relative(base, path).startsWith('..') || isAbsolute(relative(base, path))) throw new Error('辅助引擎文件越过任务目录。')
  const rootInfo = await lstat(base)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('辅助任务目录不安全。')
  let current = base
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) || (info.isFile() && info.nlink > 1)) throw new Error('辅助任务文件所有权无法确认。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return path; throw error }
  }
  return path
}

export class WindowsAuxiliaryTransfer {
  readonly filesDirectory: string
  private readonly journalPath: string
  private journal: Journal | null = null
  private sourceHash = ''
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly taskID: number, readonly generation: number, readonly source: WindowsAuxiliarySource, private readonly workDirectory: string,
    private readonly daemon: WindowsAuxiliaryDaemonProvider, private credentials?: WindowsAuxiliaryCredentials, private readonly filename?: string) {
    if (!Number.isSafeInteger(taskID) || taskID < 1 || !Number.isSafeInteger(generation) || generation < 1) throw new Error('辅助任务标识无效。')
    this.filesDirectory = join(workDirectory, 'files'); this.journalPath = join(workDirectory, 'transfer.json')
  }
  private run<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => undefined).then(action); this.queue = next.catch(() => undefined); return next }
  async initialize(): Promise<void> {
    if (this.journal) { await this.verifyDirectories(this.journal); return }
    await mkdir(this.workDirectory, { recursive: true, mode: 0o700 })
    const workInfo = await lstat(this.workDirectory)
    if (workInfo.isSymbolicLink() || !workInfo.isDirectory()) throw new Error('辅助任务目录不安全。')
    await mkdir(this.filesDirectory, { recursive: true, mode: 0o700 })
    const filesInfo = await lstat(this.filesDirectory)
    if (filesInfo.isSymbolicLink() || !filesInfo.isDirectory()) throw new Error('辅助任务目录不安全。')
    this.sourceHash = createHash('sha256').update(JSON.stringify({ source: this.source, filename: this.filename ?? null, directory: await realpath(this.filesDirectory) })).digest('hex')
    let existingJournal = false
    try {
      const info = await lstat(this.journalPath)
      existingJournal = true
      if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('辅助恢复记录无效。')
      const value = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal
      if (value.version !== 1 || value.taskID !== this.taskID || value.generation !== this.generation || value.sourceHash !== this.sourceHash || !/^[a-f\d]{16}$/.test(value.gid)
          || !Number.isSafeInteger(value.bandwidthLimit) || value.bandwidthLimit < 0 || typeof value.requestedRunning !== 'boolean' || typeof value.removed !== 'boolean' || !Array.isArray(value.files)) throw new Error('辅助恢复记录绑定不一致。')
      if (value.selectedFiles && (!value.selectedFiles.length || value.selectedFiles.some(index => !Number.isSafeInteger(index) || index < 1) || new Set(value.selectedFiles).size !== value.selectedFiles.length)) throw new Error('辅助文件选择记录无效。')
      if (value.files.length > 100000 || value.files.some(file => !Number.isSafeInteger(file.index) || file.index < 1 || !Number.isSafeInteger(file.length) || file.length < 0 || typeof file.selected !== 'boolean') || new Set(value.files.map(file => file.index)).size !== value.files.length
        || value.published !== undefined && !validPublishedArtifact(value.published)) throw new Error('辅助恢复文件记录无效。')
      await this.verifyDirectories(value)
      for (const file of value.files) await safeAuxiliaryPath(this.filesDirectory, file.relativePath)
      this.journal = value
    } catch (error) {
      if (existingJournal || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if ((await readdir(this.filesDirectory)).length) throw new Error('任务目录已有未登记文件，已保留。')
      await this.commit({ version: 1, taskID: this.taskID, generation: this.generation, sourceHash: this.sourceHash, workIdentity: identity(workInfo), filesIdentity: identity(filesInfo), gid: randomBytes(8).toString('hex'), bandwidthLimit: 0, requestedRunning: false, removed: false, files: [] })
    }
  }
  private async verifyDirectories(record: Journal): Promise<void> {
    for (const [path, expected] of [[this.workDirectory, record.workIdentity], [this.filesDirectory, record.filesIdentity]] as const) {
      const info = await lstat(path)
      if (!validIdentity(expected) || info.isSymbolicLink() || !info.isDirectory() || info.dev !== expected.device || info.ino !== expected.inode) throw new Error('辅助任务目录被更换，已保留现有文件。')
    }
  }
  private async commit(next: Journal): Promise<void> { await writeAtomicWindowsState(this.journalPath, JSON.stringify(next)); this.journal = next }
  private async update(patch: Partial<Journal>): Promise<void> { await this.commit({ ...this.journal!, ...patch }) }
  private async options(): Promise<Record<string, string>> {
    const record = this.journal!, result: Record<string, string> = { gid: record.gid, dir: this.filesDirectory, pause: 'true', continue: 'true', 'auto-file-renaming': 'false', 'allow-overwrite': 'false', 'max-download-limit': String(record.bandwidthLimit) }
    if (this.filename && auxiliaryKind(this.source) !== 'bittorrent') result.out = this.filename
    if (auxiliaryKind(this.source) === 'bittorrent') {
      result['pause-metadata'] = 'true'; result['bt-metadata-only'] = 'false'
      if (record.selectedFiles) result['select-file'] = record.selectedFiles.join(',')
    }
    if (this.source.kind === 'sftp') {
      if (!this.credentials?.username || !this.credentials.password) throw Object.assign(new Error('请为原任务补充 SFTP 账号密码。'), { code: 'credentialsRequired' })
      result['sftp-user'] = this.credentials.username; result['sftp-passwd'] = this.credentials.password
      result['ssh-host-key-sha256'] = this.source.hostKeySHA256.replace(/^SHA256:/, '') + (this.source.hostKeySHA256.replace(/^SHA256:/, '').length % 4 ? '=' : '')
    }
    return result
  }
  private async rawSnapshot(rpc: WindowsAuxiliaryRPC): Promise<AuxiliarySnapshot> {
    const record = this.journal!, raw = await rpc.call<any>('aria2.tellStatus', [record.gid])
    if (!raw || raw.gid !== record.gid || !['active', 'waiting', 'paused', 'complete', 'error', 'removed'].includes(raw.status) || (Array.isArray(raw.followedBy) && raw.followedBy.length) || !Array.isArray(raw.files) || raw.files.length > 100000) throw new WindowsAuxiliaryRPCError('invalidResponse')
    const total = integer(raw.totalLength), completed = integer(raw.completedLength)
    const btState = raw.bittorrent?.state
    const metadata = btState === 'downloadingMetadata' || btState === 'adding' && !raw.bittorrent?.info
    const files: AuxiliaryFile[] = []
    for (const entry of raw.files) {
      if (metadata && entry.path === '') continue
      if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) throw new Error('辅助引擎返回无效文件路径。')
      const relativePath = relative(this.filesDirectory, resolve(entry.path)).split('\\').join('/')
      await safeAuxiliaryPath(this.filesDirectory, relativePath)
      let length = integer(entry.length)
      if (length === 0 && raw.files.length === 1 && total > 0) length = total
      files.push({ index: integer(entry.index), relativePath, length, completedLength: integer(entry.completedLength), selected: bool(entry.selected) })
    }
    const selected = files.filter(file => file.selected)
    const selectionMatches = !!record.selectedFiles && JSON.stringify([...record.selectedFiles].sort((a,b)=>a-b)) === JSON.stringify(selected.map(file=>file.index).sort((a,b)=>a-b))
    const awaiting = auxiliaryKind(this.source) === 'bittorrent' && !metadata && !selectionMatches
    const phase = raw.status === 'error' ? 'error' : raw.status === 'removed' ? 'removed' : awaiting ? 'awaitingSelection' : metadata ? 'metadata' : raw.status === 'complete' ? 'complete'
      : btState === 'seeding' || (raw.seeder === 'true' || raw.seeder === true) && raw.status === 'active' ? 'seeding' : raw.status === 'paused' ? 'paused' : ['checking','recovering'].includes(btState) ? 'checking' : 'downloading'
    let payloadCompleted = !metadata && !awaiting && selected.length > 0 && selected.every(file => file.completedLength === file.length)
      && (phase === 'complete' || phase === 'seeding' || phase === 'paused' && record.payloadVerified === true)
    if (payloadCompleted) for (const file of selected) {
      try { const path = await safeAuxiliaryPath(this.filesDirectory, file.relativePath, false); if ((await stat(path)).size !== file.length) payloadCompleted = false }
      catch { payloadCompleted = false }
    }
    if (payloadCompleted && !record.payloadVerified) await this.update({ payloadVerified: true })
    const uploadedBytes = raw.uploadLength === undefined ? undefined : integer(raw.uploadLength)
    const candidate = { taskID: this.taskID, generation: this.generation, kind: auxiliaryKind(this.source), phase, totalBytes: total, completedBytes: completed,
      downloadSpeed: integer(raw.downloadSpeed), uploadSpeed: integer(raw.uploadSpeed ?? '0'), payloadCompleted, files,
      ...(uploadedBytes === undefined ? {} : { uploadedBytes, ...(completed > 0 ? { ratio: uploadedBytes / completed } : {}) }), errorCode: raw.errorCode }
    const snapshot = readAuxiliarySnapshot({ ok: true, snapshot: candidate }, this.taskID)
    if (!snapshot) throw new WindowsAuxiliaryRPCError('invalidResponse')
    const manifest = files.map(file => ({ ...file, completedLength: 0 }))
    if (JSON.stringify(manifest) !== JSON.stringify(record.files)) await this.update({ files: manifest })
    return snapshot
  }
  private async prepare(): Promise<AuxiliarySnapshot> {
    await this.initialize()
    if (this.journal!.removed) throw new Error('辅助任务已移除。')
    const capabilities = await this.daemon.start(), kind = auxiliaryKind(this.source)
    if (!capabilities[kind]) throw new Error('辅助引擎不支持当前协议。')
    const rpc = await this.daemon.rpc()
    try { return await this.rawSnapshot(rpc) }
    catch (error) { if (!(error instanceof WindowsAuxiliaryRPCError) || error.kind !== 'notFound') throw error }
    const options = await this.options()
    const gid = this.source.kind === 'torrent'
      ? await rpc.call('aria2.addTorrent', [this.source.torrentData, [], options])
      : await rpc.call('aria2.addUri', [[this.source.url], options])
    if (gid !== this.journal!.gid) throw new WindowsAuxiliaryRPCError('invalidResponse')
    await this.update({ requestedRunning: false })
    return this.rawSnapshot(rpc)
  }
  status(): Promise<AuxiliarySnapshot> { return this.run(() => this.prepare()) }
  start(): Promise<AuxiliarySnapshot> { return this.run(async () => {
    let snapshot = await this.prepare()
    const rpc = await this.daemon.rpc()
    if (snapshot.phase === 'awaitingSelection' && this.journal!.selectedFiles) {
      await this.pauseUnlocked()
      await rpc.call('aria2.changeOption', [this.journal!.gid, { 'select-file': this.journal!.selectedFiles.join(',') }]); snapshot = await this.rawSnapshot(rpc)
    }
    if (['complete','seeding','awaitingSelection'].includes(snapshot.phase)) return snapshot
    if (snapshot.phase === 'error') { await rpc.call('aria2.removeDownloadResult', [this.journal!.gid]); snapshot = await this.prepare() }
    await this.update({ requestedRunning: true })
    const current = await rpc.call<any>('aria2.tellStatus', [this.journal!.gid])
    if (current.gid !== this.journal!.gid) throw new WindowsAuxiliaryRPCError('invalidResponse')
    if (current.status === 'paused') await rpc.call('aria2.unpause', [this.journal!.gid])
    return this.rawSnapshot(rpc)
  }) }
  private async waitStopped(rpc: WindowsAuxiliaryRPC, removing: boolean): Promise<void> {
    const deadline = Date.now() + 5000
    do {
      try { const status = await rpc.call<any>('aria2.tellStatus', [this.journal!.gid]); if (status.gid !== this.journal!.gid) throw new WindowsAuxiliaryRPCError('invalidResponse'); if (['complete','error','removed', ...(removing ? [] : ['paused'])].includes(status.status)) return }
      catch (error) { if (removing && error instanceof WindowsAuxiliaryRPCError && error.kind === 'notFound') return; throw error }
      await auxiliaryDelay(50)
    } while (Date.now() < deadline)
    throw new Error('辅助引擎尚未确认停止。')
  }
  private async pauseUnlocked(): Promise<AuxiliarySnapshot> {
    const snapshot = await this.prepare(), rpc = await this.daemon.rpc()
    await this.update({ requestedRunning: false })
    if (!['complete','error','removed'].includes(snapshot.phase)) {
      const current = await rpc.call<any>('aria2.tellStatus', [this.journal!.gid])
      if (current.gid !== this.journal!.gid) throw new WindowsAuxiliaryRPCError('invalidResponse')
      if (current.status !== 'paused') await rpc.call('aria2.forcePause', [this.journal!.gid])
      await this.waitStopped(rpc, false)
    }
    return this.rawSnapshot(rpc)
  }
  pause(): Promise<AuxiliarySnapshot> { return this.run(() => this.pauseUnlocked()) }
  selectFiles(indices: number[]): Promise<AuxiliarySnapshot> { return this.run(async () => {
    const snapshot = await this.pauseUnlocked()
    const allowed = new Set(snapshot.files.map(file => file.index))
    if (auxiliaryKind(this.source) !== 'bittorrent' || !indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || !allowed.has(index))) throw new Error('请选择至少一个有效文件。')
    await this.update({ selectedFiles: [...indices].sort((a,b)=>a-b), requestedRunning: false, payloadVerified: false })
    const rpc = await this.daemon.rpc()
    await rpc.call('aria2.changeOption', [this.journal!.gid, { 'select-file': this.journal!.selectedFiles!.join(',') }])
    return this.rawSnapshot(rpc)
  }) }
  authenticate(credentials: WindowsAuxiliaryCredentials): Promise<void> { return this.run(async () => {
    if (this.source.kind !== 'sftp') throw new Error('当前任务不是 SFTP。')
    this.credentials = { ...credentials }
    const snapshot = await this.pauseUnlocked()
    if (!['complete','error','removed'].includes(snapshot.phase)) {
      const rpc = await this.daemon.rpc(), options = await this.options()
      await rpc.call('aria2.changeOption', [this.journal!.gid, { 'sftp-user': options['sftp-user'], 'sftp-passwd': options['sftp-passwd'], 'ssh-host-key-sha256': options['ssh-host-key-sha256'] }])
    }
  }) }
  bandwidth(bytes: number): Promise<void> { return this.run(async () => { await this.initialize(); await this.update({ bandwidthLimit: bytes }); const rpc = await this.daemon.rpc(); await this.prepare(); await rpc.call('aria2.changeOption', [this.journal!.gid, { 'max-download-limit': String(bytes) }]) }) }
  cancel(): Promise<void> { return this.run(async () => {
    await this.initialize(); await this.update({ removed: true, requestedRunning: false })
    const rpc = await this.daemon.rpc()
    try {
      const existing = await rpc.call<any>('aria2.tellStatus', [this.journal!.gid])
      await rpc.call(['complete','error','removed'].includes(existing.status) ? 'aria2.removeDownloadResult' : 'aria2.forceRemove', [this.journal!.gid]); await this.waitStopped(rpc, true)
    } catch (error) { if (!(error instanceof WindowsAuxiliaryRPCError) || error.kind !== 'notFound') throw error }
  }) }
  async verifyPublished(artifact: PublishedAuxiliaryArtifact): Promise<void> {
    if (!validPublishedArtifact(artifact)) throw new Error('交付文件记录无效。')
    const info = await lstat(artifact.path)
    if (info.isSymbolicLink() || info.dev !== artifact.device || info.ino !== artifact.inode || info.isDirectory() !== artifact.directory || (!artifact.directory && (!info.isFile() || info.size !== artifact.size || info.nlink > 1))) throw new Error('已交付文件被更换，已保留现有文件。')
    for (const file of artifact.files ?? []) {
      const info = await lstat(await safeAuxiliaryPath(artifact.path, file.relativePath, false))
      if (info.dev !== file.device || info.ino !== file.inode || info.size !== file.size) throw new Error('交付目录中的文件被更换，已保留现有文件。')
    }
  }
  async published(): Promise<PublishedAuxiliaryArtifact | undefined> { await this.initialize(); const artifact = this.journal!.published; if (artifact) await this.verifyPublished(artifact); return artifact }
  async publish(destination: string, suggestedName: string): Promise<PublishedAuxiliaryArtifact> {
    await this.initialize()
    if (this.journal!.published) { await this.verifyPublished(this.journal!.published); if (resolve(dirname(this.journal!.published.path)) !== resolve(destination)) throw new Error('交付记录的目标目录不一致。'); return this.journal!.published }
    const snapshot = await this.status()
    if (!snapshot.payloadCompleted || !['paused','complete'].includes(snapshot.phase)) throw new Error('停止做种或确认下载完成后才能交付文件。')
    const files = snapshot.files.filter(file => file.selected)
    for (const file of files) { const path = await safeAuxiliaryPath(this.filesDirectory, file.relativePath, false); if ((await stat(path)).size !== file.length) throw new Error('辅助任务文件长度尚未验证。') }
    await mkdir(destination, { recursive: true })
    const base = sanitizeWindowsFilename(suggestedName || `辅助任务-${this.taskID}`)
    let output = ''
    if (files.length === 1) {
      const file = files[0], source = await safeAuxiliaryPath(this.filesDirectory, file.relativePath, false)
      const name = auxiliaryKind(this.source) === 'bittorrent' ? basename(file.relativePath) : base
      for (let i = 0; i < 10000; i++) {
        const extension = extname(name)
        const candidate = join(destination, i ? `${name.slice(0, name.length - extension.length)} (${i + 1})${extension}` : name)
        try { await copyFile(source, candidate, constants.COPYFILE_EXCL); output = candidate; break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    } else {
      for (let i = 0; i < 10000; i++) {
        const candidate = join(destination, i ? `${base} (${i + 1})` : base)
        try { await mkdir(candidate); output = candidate; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      if (!output) throw new Error('无法分配新的交付目录。')
      for (const file of files) {
        const source = await safeAuxiliaryPath(this.filesDirectory, file.relativePath, false), target = join(output, file.relativePath)
        await mkdir(dirname(target), { recursive: true }); await copyFile(source, target, constants.COPYFILE_EXCL)
      }
    }
    if (!output) throw new Error('无法分配新的交付文件。')
    const info = await lstat(output)
    const publishedFiles: Array<FileIdentity & { relativePath: string }> = []
    const syncFile = async (path: string) => { const handle = await open(path, 'r+'); try { await handle.sync() } finally { await handle.close() } }
    if (info.isDirectory()) for (const file of files) {
      const path = await safeAuxiliaryPath(output, file.relativePath, false)
      await syncFile(path); publishedFiles.push({ relativePath: file.relativePath, ...identity(await lstat(path)) })
    }
    else await syncFile(output)
    const artifact = { path: output, directory: info.isDirectory(), ...identity(info), ...(info.isDirectory() ? { files: publishedFiles } : {}) }
    await this.update({ published: artifact })
    return artifact
  }
  async deletePublished(artifact: PublishedAuxiliaryArtifact): Promise<void> {
    await this.initialize(); await this.verifyPublished(artifact)
    if (!artifact.directory) { await unlink(artifact.path); return }
    // Never recursively delete unrelated files the user added to a delivered folder.
    for (const file of this.journal!.files.filter(file => file.selected)) {
      const path = await safeAuxiliaryPath(artifact.path, file.relativePath, false)
      if ((await stat(path)).size !== file.length) throw new Error('交付目录已改变，已保留文件。')
    }
    for (const file of this.journal!.files.filter(file => file.selected)) await unlink(await safeAuxiliaryPath(artifact.path, file.relativePath, false))
  }
  async cleanup(): Promise<void> { await this.initialize(); if (!this.journal!.removed) throw new Error('辅助引擎仍拥有任务目录。'); await rm(this.workDirectory, { recursive: true, force: true }) }
}
