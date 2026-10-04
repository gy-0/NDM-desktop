import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeAtomicWindowsState } from './creationReceipts'

type DirectoryIdentity = { device: string; inode: string }
type Attempt = { generation: number; sourceIndex: number; directoryIdentity: DirectoryIdentity }
type Journal = { version: 1; taskID: number; sourcesHash: string; rootIdentity: DirectoryIdentity; attempts: Attempt[] }
export type MirrorAttempt = { generation: number; sourceIndex: number; url: string; directory: string }
const identity = async (path: string): Promise<DirectoryIdentity> => {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('镜像任务目录所有权无法确认。')
  return { device: String(info.dev), inode: String(info.ino) }
}
const matches = (a: DirectoryIdentity, b: DirectoryIdentity | undefined): boolean =>
  !!b && a.device === b.device && a.inode === b.inode

/** One engine owns this journal. Call advance only after its previous writer settles.
 * No transfer, publication or artifact deletion is performed by this layer.
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
      if (!matches(await identity(this.directory(attempt.generation)), attempt.directoryIdentity)) throw new Error('镜像下载目录被替换，已保留文件。')
    }
  }
  private async initialize(): Promise<void> {
    if (this.record) { await this.verify(this.record); return }
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
      await this.verify(value)
      this.record = value
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
    return { generation: last.generation, sourceIndex: last.sourceIndex, url: this.sources[last.sourceIndex], directory: resolve(this.directory(last.generation)) }
  }
  current(): Promise<MirrorAttempt> { return this.run(async () => { await this.initialize(); return this.snapshot() }) }
  advance(expectedGeneration: number): Promise<MirrorAttempt> {
    return this.run(async () => {
      await this.initialize()
      const current = this.snapshot()
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
}
