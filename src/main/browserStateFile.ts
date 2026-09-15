import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { BrowserSessionReadStage } from '../shared/browserSessions'

export type BrowserStateFailureCause = 'ENOENT' | 'ENOTDIR' | 'EACCES' | 'EPERM' | 'EIO' | 'EMFILE' | 'ENFILE' | 'EBUSY' | 'EAGAIN' | 'EINTR' | 'EBADF' | 'ERR_INVALID_ARG_TYPE' | 'ERR_INVALID_ARG_VALUE' | 'ERR_OUT_OF_RANGE' | 'TypeError' | 'ReferenceError' | 'RangeError' | 'changed' | 'malformed' | 'tooLarge' | 'notRegular' | 'unknown'
const fileCauses: readonly string[] = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'EINTR', 'EBADF', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE']
export class BrowserStateReadError extends Error {
  constructor(public readonly cause: BrowserStateFailureCause, public readonly stage: BrowserSessionReadStage = 'read') {
    super(`Browser metadata read failed (${stage}/${cause})`)
  }
}
export function browserStateFailureCause(error: unknown): BrowserStateFailureCause {
  if (error instanceof BrowserStateReadError) return error.cause
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (typeof code === 'string' && fileCauses.includes(code)) return code as BrowserStateFailureCause
  return error instanceof Error && ['TypeError', 'ReferenceError', 'RangeError'].includes(error.name) ? error.name as BrowserStateFailureCause : 'unknown'
}
export function browserStateFailureStage(error: unknown, fallback: BrowserSessionReadStage = 'read'): BrowserSessionReadStage {
  return error instanceof BrowserStateReadError ? error.stage : fallback
}
type StateStat = { size: number; mtimeMs: number; isFile(): boolean }
type StateHandle = {
  stat(): Promise<StateStat>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
type Dependencies = { openFile(path: string): Promise<StateHandle>; pause(): Promise<void> }
const defaults: Dependencies = {
  openFile: path => open(path, constants.O_RDONLY | constants.O_NONBLOCK),
  pause: () => new Promise(resolve => setTimeout(resolve, 25))
}
const maximumBytes = 8 * 1024 * 1024

/** Read only Local State metadata, with a bounded allocation and retries for a
 * browser replacing/writing that file. A short read is not itself an EOF. */
export async function readBrowserStateFile(path: string, dependencies: Dependencies = defaults): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let file: StateHandle | undefined
    let stage: BrowserSessionReadStage = 'open'
    try {
      file = await dependencies.openFile(path)
      stage = 'stat'
      const before = await file.stat()
      if (!before.isFile()) throw new BrowserStateReadError('notRegular', stage)
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) throw new BrowserStateReadError('tooLarge', stage)
      const buffer = Buffer.alloc(before.size + 1)
      let total = 0
      stage = 'read'
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) throw new BrowserStateReadError('unknown')
        if (bytesRead === 0) break
        total += bytesRead
      }
      stage = 'stat'
      const after = await file.stat()
      if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new BrowserStateReadError('changed')
      stage = 'parse'
      try { return JSON.parse(buffer.subarray(0, total).toString('utf8')) }
      catch { throw new BrowserStateReadError('malformed', stage) }
    } catch (error) {
      const cause = browserStateFailureCause(error)
      if (attempt === 2 || !['changed', 'malformed', 'EBUSY', 'EAGAIN', 'EINTR'].includes(cause)) {
        throw new BrowserStateReadError(cause, browserStateFailureStage(error, stage))
      }
    } finally { await file?.close().catch(() => undefined) }
    await dependencies.pause()
  }
  throw new BrowserStateReadError('changed')
}
