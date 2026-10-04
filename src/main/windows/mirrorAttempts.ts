import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, link, open, unlink, rmdir } from 'node:fs/promises'
import { join, resolve, dirname, basename, isAbsolute } from 'node:path'
import { writeAtomicWindowsState } from './creationReceipts'

type DirectoryIdentity = { device: string; inode: string }
type Attempt = { generation: number; sourceIndex: number; directoryIdentity: DirectoryIdentity }
type PayloadIdentity = DirectoryIdentity & { bytes: string; modified: string }
type Publication = { generation: number; destination: string; parent: DirectoryIdentity; payload: PayloadIdentity; phase: 'prepared' | 'published' }
type Journal = { version: 1; taskID: number; sourcesHash: string; rootIdentity: DirectoryIdentity; attempts: Attempt[]; publication?: Publication; cleanup?: boolean; overrides?: Record<string, string> }
export type MirrorAttempt = { generation: number; sourceIndex: number; url: string; directory: string }
const identity = async (path: string): Promise<DirectoryIdentity> => {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('镜像任务目录所有权无法确认。')
  return { device: String(info.dev), inode: String(info.ino) }
}
const matches = (a: DirectoryIdentity, b: DirectoryIdentity | undefined): boolean =>
  !!b && a.device === b.device && a.inode === b.inode

/** One engine owns this journal. Call advance only after its previous writer settles.
 * The caller must settle writers before preparing publication. No artifact deletion
 * or transfer is performed here; publication requires a same-volume hard link.
 */
export class WindowsMirrorAttempts {
  private record?: Journal
  private queue: Promise<unknown> = Promise.resolve()
  private readonly sources: readonly string[]
  constructor(private readonly root: string, private readonly taskID: number, sources: readonly string[]) {
    if (!Number.isSafeInteger(taskID) || taskID < 1 || sources.length < 2 || sources.length > 33) throw new Error('镜像任务标识无效。')
    this.sources = Object.freeze(sources.map(source => {
      const url = new URL(source)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('镜像来源无效。')
      return url.href
    }))
    if (new Set(this.sources).size !== this.sources.length) throw new Error('镜像来源重复。')
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(action)
    this.queue = next.catch(() => undefined)
    return next
  }
  private directory(generation: number): string { return join(this.root, `attempt-${generation}`) }
  private async verify(record: Journal): Promise<void> {
    if (!matches(await identity(this.root), record.rootIdentity)) throw new Error('镜像任务目录被替换，已保留文件。')
    for (const attempt of record.attempts) {
      try {
        if (!matches(await identity(this.directory(attempt.generation)), attempt.directoryIdentity)) throw new Error('镜像下载目录被替换，已保留文件。')
      } catch (error) { if (!record.cleanup || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  private async initialize(allowCleanup = false): Promise<void> {
    if (this.record) { await this.verify(this.record); if (this.record.cleanup && !allowCleanup) throw new Error('镜像任务正在清理。'); return }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootIdentity = await identity(this.root)
    const sourcesHash = createHash('sha256').update(JSON.stringify({ taskID: this.taskID, sources: this.sources, root: await realpath(this.root) })).digest('hex')
    const path = join(this.root, 'attempts.json')
    let exists = false
    try {
      const info = await lstat(path); exists = true
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) throw new Error('镜像恢复记录无效。')
      const value = JSON.parse(await readFile(path, 'utf8')) as Journal
      if (value.version !== 1 || value.taskID !== this.taskID || value.sourcesHash !== sourcesHash || !Array.isArray(value.attempts)
          || value.attempts.length < 1 || value.attempts.length > this.sources.length
          || value.attempts.some((attempt, index) => !attempt || attempt.generation !== index + 1 || attempt.sourceIndex !== index)) throw new Error('镜像恢复记录与任务不一致。')
      if (value.cleanup !== undefined && typeof value.cleanup !== 'boolean') throw new Error('镜像清理记录无效。')
      if (value.overrides !== undefined && (!value.overrides || typeof value.overrides !== 'object' || Array.isArray(value.overrides)
          || Object.entries(value.overrides).some(([key, url]) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= this.sources.length || typeof url !== 'string' || !this.validSource(url)))) throw new Error('镜像更新来源记录无效。')
      const publication = value.publication
      if (publication !== undefined && (!publication || typeof publication !== 'object' || publication.generation !== value.attempts.length || typeof publication.destination !== 'string'
          || !isAbsolute(publication.destination) || !['prepared', 'published'].includes(publication.phase)
          || !publication.payload || !['device', 'inode', 'bytes', 'modified'].every(key => typeof publication.payload[key as keyof PayloadIdentity] === 'string' && /^\d+$/.test(publication.payload[key as keyof PayloadIdentity])))) throw new Error('镜像交付记录无效。')
      await this.verify(value)
      this.record = value
      if (value.cleanup && !allowCleanup) throw new Error('镜像任务正在清理。')
      return
    } catch (error) {
      if (exists || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // An interrupted creation is preserved rather than claimed as owned data.
    if ((await readdir(this.root)).length) throw new Error('镜像目录含未登记文件，已保留。')
    await mkdir(this.directory(1), { mode: 0o700 })
    const record: Journal = { version: 1, taskID: this.taskID, sourcesHash, rootIdentity,
      attempts: [{ generation: 1, sourceIndex: 0, directoryIdentity: await identity(this.directory(1)) }] }
    await writeAtomicWindowsState(path, JSON.stringify(record))
    this.record = record
  }
  private snapshot(): MirrorAttempt {
    const last = this.record!.attempts.at(-1)!
    return { generation: last.generation, sourceIndex: last.sourceIndex, url: this.record!.overrides?.[String(last.sourceIndex)] ?? this.sources[last.sourceIndex], directory: resolve(this.directory(last.generation)) }
  }
  current(): Promise<MirrorAttempt> { return this.run(async () => { await this.initialize(); return this.snapshot() }) }
  advance(expectedGeneration: number): Promise<MirrorAttempt> {
    return this.run(async () => {
      await this.initialize()
      const current = this.snapshot()
      if (this.record!.publication) throw new Error('镜像文件正在交付，不能切换来源。')
      if (current.generation !== expectedGeneration) throw new Error('镜像切换操作已过期。')
      if (current.sourceIndex + 1 >= this.sources.length) throw new Error('所有镜像来源均已尝试。')
      const generation = current.generation + 1
      // Exclusive mkdir prevents adopting an orphan or another attempt's bytes.
      await mkdir(this.directory(generation), { mode: 0o700 })
      const next: Journal = { ...this.record!, attempts: [...this.record!.attempts, {
        generation, sourceIndex: current.sourceIndex + 1, directoryIdentity: await identity(this.directory(generation))
      }] }
      await writeAtomicWindowsState(join(this.root, 'attempts.json'), JSON.stringify(next))
      this.record = next
      return this.snapshot()
    })
  }
  private async payloadIdentity(path: string): Promise<PayloadIdentity> {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('镜像交付文件无效。')
    return { device: String(info.dev), inode: String(info.ino), bytes: String(info.size), modified: String(info.mtimeNs) }
  }
  private samePayload(a: PayloadIdentity, b: PayloadIdentity): boolean {
    return matches(a, b) && a.bytes === b.bytes && a.modified === b.modified
  }
  /** payload.bin is reserved to the settled writer of this source generation. */
  preparePublication(expectedGeneration: number, destination: string, expectedBytes: number): Promise<void> {
    return this.run(async () => {
      await this.initialize()
      if (this.snapshot().generation !== expectedGeneration || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0
          || !isAbsolute(destination) || /[\\:\x00-\x1f]/.test(basename(destination))) throw new Error('镜像交付参数无效。')
      destination = join(await realpath(dirname(destination)), basename(destination))
      const payload = await this.payloadIdentity(join(this.snapshot().directory, 'payload.bin'))
      if (payload.bytes !== String(expectedBytes)) throw new Error('镜像交付文件大小不一致。')
      const previous = this.record!.publication
      if (previous) {
        if (previous.destination !== destination || !this.samePayload(payload, previous.payload)) throw new Error('镜像交付记录不一致。')
        return
      }
      const info = await lstat(join(this.snapshot().directory, 'payload.bin'))
      if (info.nlink !== 1) throw new Error('镜像交付文件已被其他路径引用。')
      const file = await open(join(this.snapshot().directory, 'payload.bin'), 'r')
      try { await file.sync() } finally { await file.close() }
      const publication: Publication = { generation: expectedGeneration, destination, parent: await identity(dirname(destination)), payload, phase: 'prepared' }
      const next: Journal = { ...this.record!, publication }
      await writeAtomicWindowsState(join(this.root, 'attempts.json'), JSON.stringify(next))
      this.record = next
    })
  }
  publication(): Promise<{ bytes: number } | undefined> {
    return this.run(async () => {
      await this.initialize()
      const value = this.record!.publication
      if (!value) return undefined
      const bytes = Number(value.payload.bytes)
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('镜像交付大小无效。')
      return { bytes }
    })
  }
  publish(): Promise<string> {
    return this.run(async () => {
      await this.initialize()
      const publication = this.record!.publication
      if (!publication) throw new Error('镜像文件尚未准备交付。')
      if (!matches(await identity(dirname(publication.destination)), publication.parent)) throw new Error('镜像交付目录被替换。')
      const source = join(this.snapshot().directory, 'payload.bin')
      if (!this.samePayload(await this.payloadIdentity(source), publication.payload)) throw new Error('镜像交付源文件已变化。')
      try {
        const output = await this.payloadIdentity(publication.destination)
        if (!this.samePayload(output, publication.payload)) throw new Error('目标文件已存在，已保留。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (publication.phase === 'published') throw new Error('已交付文件被移走，未重新创建。')
        // link is exclusive; a racing destination creation is never overwritten.
        // EXDEV/unsupported filesystems leave staging and intent intact.
        await link(source, publication.destination)
      }
      if (!this.samePayload(await this.payloadIdentity(publication.destination), publication.payload)) throw new Error('镜像交付文件发生变化。')
      const next: Journal = { ...this.record!, publication: { ...publication, phase: 'published' } }
      await writeAtomicWindowsState(join(this.root, 'attempts.json'), JSON.stringify(next))
      this.record = next
      return publication.destination
    })
  }

  /** Caller must stop all writers before cleanup or deleting published output. */
  deletePublished(): Promise<void> {
    return this.run(async () => {
      await this.initialize(true)
      const publication = this.record!.publication
      if (!publication) return
      if (!matches(await identity(dirname(publication.destination)), publication.parent)) throw new Error('交付目录被替换，已保留。')
      try {
        if (!this.samePayload(await this.payloadIdentity(publication.destination), publication.payload)) throw new Error('交付文件已变化，已保留。')
        await unlink(publication.destination)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })
  }
  cleanup(): Promise<void> {
    return this.run(async () => {
      await this.initialize(true)
      const allowed = new Set(['attempts.json', ...this.record!.attempts.map(attempt => `attempt-${attempt.generation}`)])
      if ((await readdir(this.root)).some(name => !allowed.has(name))) throw new Error('镜像目录含未知内容，已保留。')
      const files: string[] = [], directories: string[] = []
      // Validate everything before deleting anything. Never recursively remove.
      for (const attempt of this.record!.attempts) {
        const directory = this.directory(attempt.generation)
        let names: string[]
        try { names = await readdir(directory) }
        catch (error) { if (this.record!.cleanup && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        for (const name of names) {
          if (!['payload.bin', 'payload.bin.aria2'].includes(name)) throw new Error('镜像分段目录含未知内容，已保留。')
          const path = join(directory, name), info = await lstat(path)
          if (!info.isFile() || info.isSymbolicLink() || (name.endsWith('.aria2') && info.nlink !== 1)) throw new Error('镜像分段所有权无法确认，已保留。')
          const publication = this.record!.publication
          if (name === 'payload.bin' && publication?.generation === attempt.generation
              && !this.samePayload(await this.payloadIdentity(path), publication.payload)) throw new Error('镜像交付源文件已变化，已保留。')
          files.push(path)
        }
        directories.push(directory)
      }
      if (!this.record!.cleanup) {
        const next: Journal = { ...this.record!, cleanup: true }
        await writeAtomicWindowsState(join(this.root, 'attempts.json'), JSON.stringify(next))
        this.record = next
      }
      for (const path of files) await unlink(path)
      for (const directory of directories) await rmdir(directory)
      await unlink(join(this.root, 'attempts.json'))
      await rmdir(this.root)
    })
  }

  private validSource(value: string): boolean {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && url.href === value } catch { return false }
  }
  effectiveSources(): Promise<string[]> {
    return this.run(async () => { await this.initialize(); return this.sources.map((url, index) => this.record!.overrides?.[String(index)] ?? url) })
  }
  /** Caller must validate representation and settle the old writer before renewal. */
  renew(expectedGeneration: number, url: string): Promise<MirrorAttempt> {
    return this.run(async () => {
      await this.initialize()
      const current = this.snapshot()
      if (current.generation !== expectedGeneration || this.record!.publication) throw new Error('镜像来源不能在当前状态更新。')
      const canonical = new URL(url).href
      if (!this.validSource(canonical)) throw new Error('镜像更新地址无效。')
      const next: Journal = { ...this.record!, overrides: { ...this.record!.overrides, [String(current.sourceIndex)]: canonical } }
      await writeAtomicWindowsState(join(this.root, 'attempts.json'), JSON.stringify(next))
      this.record = next
      return this.snapshot()
    })
  }

}
