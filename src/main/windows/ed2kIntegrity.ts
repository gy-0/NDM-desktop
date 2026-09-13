import { createMD4, type IHasher } from 'hash-wasm'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'

// MD4 is provided by pinned MIT hash-wasm 4.12.0. Its embedded WASM requires
// neither a native addon nor the unavailable Node/OpenSSL legacy MD4.
export const ED2K_PART_BYTES = 9_728_000
export class ED2KHash {
  private constructor(private part: IHasher, private aggregate: IHasher) {}
  static async create(): Promise<ED2KHash> { return new ED2KHash(await createMD4(), await createMD4()) }
  private result: string | undefined
  private partBytes = 0
  private fullParts = 0
  update(bytes: Uint8Array): void {
    if (this.result) throw new Error('ED2K hash already finalized')
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(bytes.length - offset, ED2K_PART_BYTES - this.partBytes)
      this.part.update(bytes.subarray(offset, offset + length)); this.partBytes += length; offset += length
      if (this.partBytes === ED2K_PART_BYTES) {
        this.aggregate.update(this.part.digest('binary')); this.part.init(); this.partBytes = 0; this.fullParts++
      }
    }
  }
  hex(): string {
    // ED2K appends the empty final part for an exact multiple of the part size.
    this.result ??= this.fullParts ? this.aggregate.update(this.part.digest('binary')).digest('hex') : this.part.digest('hex')
    return this.result
  }
}

/** Hash exactly the bytes written to an owned, exclusive staging copy. A failed
 * comparison never receives the requested final filename or a completed task. */
export async function copyVerifiedED2K(source: string, staging: string, expectedBytes: number, expectedHash: string): Promise<void> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await input.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedBytes || !/^[a-f\d]{32}$/i.test(expectedHash)) throw new Error('ED2K 文件长度或所有权无法确认。')
    output = await open(staging, 'wx', 0o600)
    const hash = await ED2KHash.create(), buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > expectedBytes) throw new Error('ED2K 文件在交付期间发生变化。')
      let offset = 0
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
        if (!bytesWritten) throw new Error('ED2K 校验副本写入失败。')
        offset += bytesWritten
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await input.stat()
    if (total !== expectedBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.hex() !== expectedHash.toLowerCase()) throw new Error('ED2K 文件内容与链接校验值不符；已保留下载内容。')
    await output.sync()
  } catch (error) {
    if (output) { await output.close(); output = undefined; await unlink(staging).catch(() => undefined) }
    throw error
  } finally { await input.close(); await output?.close() }
}
