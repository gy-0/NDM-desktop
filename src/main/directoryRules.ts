import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defaultDirectoryRules, DIRECTORY_RULE_LIMITS, isDirectoryForPlatform, resolveDirectoryRule, validateDirectoryRules,
  type DirectoryRulesConfig, type DirectoryRulesPlatform, type DirectoryRulesReply, type DirectoryRulesSample
} from '../shared/directoryRules'

export type DirectoryRulesState = DirectoryRulesConfig & { revision: number }
export type DirectoryRulesStorage = { read(): Promise<string | null>; write(value: string): Promise<void> }
export interface DirectoryRulesDependencies {
  statePath: string
  chooseDirectory: () => Promise<string | null>
  /** Existing engine category/default policy, with no rule override. */
  resolveFallbackDirectory: (sample: DirectoryRulesSample) => Promise<string>
  /** Must resolve only after the authoritative engine accepted the configuration. */
  applyConfig?: (config: DirectoryRulesConfig) => Promise<void>
  platform?: DirectoryRulesPlatform
  storage?: DirectoryRulesStorage
}

function fileStorage(path: string): DirectoryRulesStorage {
  return {
    async read() {
      let file
      try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > DIRECTORY_RULE_LIMITS.bytes + 1024) throw new Error('invalid state')
        const bytes = Buffer.alloc(info.size + 1)
        let size = 0
        while (size < bytes.length) {
          const result = await file.read(bytes, size, bytes.length - size, null)
          if (!result.bytesRead) break
          size += result.bytesRead
        }
        if (size > info.size) throw new Error('file changed')
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
      } finally { await file.close() }
    },
    async write(value) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      let file
      try {
        file = await open(temporary, 'wx', 0o600)
        await file.writeFile(value, 'utf8'); await file.sync(); await file.close(); file = undefined
        await rename(temporary, path)
      } finally { await file?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
    }
  }
}

function readState(content: string): DirectoryRulesState {
  if (Buffer.byteLength(content) > DIRECTORY_RULE_LIMITS.bytes + 1024) throw new Error('too large')
  const parsed = JSON.parse(content) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0 || Number(parsed.revision) >= Number.MAX_SAFE_INTEGER) throw new Error('invalid revision')
  const { revision, ...config } = parsed
  return { ...validateDirectoryRules(config), revision: Number(revision) }
}
const configOf = ({ revision: _revision, ...config }: DirectoryRulesState): DirectoryRulesConfig => structuredClone(config)

/** JSON is configuration only, never download history or a URL sample log. */
export class DirectoryRulesService {
  private state: DirectoryRulesState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly storage: DirectoryRulesStorage
  private readonly platform: DirectoryRulesPlatform
  constructor(private readonly dependencies: DirectoryRulesDependencies) {
    this.storage = dependencies.storage ?? fileStorage(dependencies.statePath)
    this.platform = dependencies.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  }

  async getConfig(): Promise<DirectoryRulesConfig> {
    const reply = await this.request('directoryRulesGet')
    if (!reply.ok || !('config' in reply)) throw new Error(reply.ok ? '无法读取目录规则。' : reply.error)
    return reply.config
  }

  request(op: string, extra: Record<string, unknown> = {}): Promise<DirectoryRulesReply> {
    let captured: Record<string, unknown>
    try { captured = structuredClone(extra) } catch { return Promise.resolve({ ok: false, error: '目录规则请求无效。' }) }
    const result = this.queue.then(async (): Promise<DirectoryRulesReply> => {
      try { await this.ensureLoaded() }
      catch { return { ok: false, code: 'storage', error: '无法读取已保存的目录规则，原文件已保留。请检查文件权限或配置版本。' } }
      if (op === 'directoryRulesGet') return this.snapshot()
      if (op === 'directoryRulesChooseDirectory') {
        try {
          const directory = await this.dependencies.chooseDirectory()
          if (directory !== null && !isDirectoryForPlatform(directory, this.platform)) return { ok: false, error: '请选择适用于当前系统的绝对目录。' }
          return { ok: true, directory }
        } catch { return { ok: false, error: '无法选择目录，请稍后重试。' } }
      }
      if (op === 'directoryRulesSave') return this.save(captured)
      if (op === 'directoryRulesPreview') return this.preview(captured)
      if (op === 'directoryRulesResolve') return this.preview({ ...captured, config: configOf(this.state!) })
      return { ok: false, error: '不支持的目录规则操作。' }
    })
    this.queue = result.catch(() => undefined)
    return result.catch(() => ({ ok: false, error: '目录规则操作未完成，请稍后重试。' }))
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return
    const content = await this.storage.read()
    this.state = content === null ? { ...defaultDirectoryRules(), revision: 0 } : readState(content)
  }
  private snapshot(): DirectoryRulesReply { return { ok: true, revision: this.state!.revision, config: configOf(this.state!) } }

  private async save(extra: Record<string, unknown>): Promise<DirectoryRulesReply> {
    if (!Number.isSafeInteger(extra.expectedRevision) || extra.expectedRevision !== this.state!.revision) {
      return { ok: false, code: 'conflict', error: '目录规则已有更新，请重新读取后再保存；当前编辑内容仍保留。' }
    }
    let config: DirectoryRulesConfig
    try { config = validateDirectoryRules(extra.config) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '目录规则无效。' } }
    const previous = structuredClone(this.state!)
    const next: DirectoryRulesState = { ...config, revision: previous.revision + 1 }
    try { await this.storage.write(JSON.stringify(next)) }
    catch { return { ok: false, code: 'storage', error: '目录规则尚未保存，请检查磁盘空间和文件权限；当前编辑内容仍保留。' } }
    this.state = next
    if (this.dependencies.applyConfig) {
      try { await this.dependencies.applyConfig(structuredClone(config)) }
      catch {
        // The engine can fail after changing memory. Restore both sides and
        // report uncertainty rather than claiming a cross-process transaction.
        let restoredFile = false, restoredEngine = false
        const rollback = { ...previous, revision: next.revision + 1 }
        try { await this.storage.write(JSON.stringify(rollback)); this.state = rollback; restoredFile = true } catch { /* Retain last known durable state. */ }
        try { await this.dependencies.applyConfig(configOf(previous)); restoredEngine = true } catch { /* Engine state remains uncertain. */ }
        return { ok: false, code: 'apply', recoveryRequired: !restoredFile || !restoredEngine,
          error: restoredFile && restoredEngine ? '引擎未能应用规则，已恢复原配置。请重新读取后再保存；当前编辑内容仍保留。' : '未能确认文件与引擎配置一致。请重新读取规则并检查引擎状态；当前编辑内容仍保留。' }
      }
    }
    return this.snapshot()
  }

  private async preview(extra: Record<string, unknown>): Promise<DirectoryRulesReply> {
    let config: DirectoryRulesConfig
    try { config = validateDirectoryRules(extra.config) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '目录规则无效。' } }
    if (!Array.isArray(extra.samples) || !extra.samples.length || extra.samples.length > 20) return { ok: false, error: '请提供 1 至 20 个预览样例。' }
    const results = []
    for (const raw of extra.samples) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '预览样例格式无效。' }
      const source = raw as Record<string, unknown>
      if (Object.keys(source).some(key => !['url', 'filename', 'explicitDirectory'].includes(key))
          || typeof source.url !== 'string' || source.url.length > DIRECTORY_RULE_LIMITS.candidateLength
          || (source.filename !== undefined && (typeof source.filename !== 'string' || source.filename.length > 512))
          || (source.explicitDirectory !== undefined && (typeof source.explicitDirectory !== 'string' || !isDirectoryForPlatform(source.explicitDirectory, this.platform)))) {
        return { ok: false, error: '样例地址、文件名或手动目录无效。' }
      }
      try { const url = new URL(source.url); if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) throw new Error('protocol') }
      catch { return { ok: false, error: '样例必须是有效的 HTTP、HTTPS 或 FTP 地址。' } }
      const sample: DirectoryRulesSample = { url: source.url,
        ...(source.filename === undefined ? {} : { filename: source.filename as string }),
        ...(source.explicitDirectory === undefined ? {} : { explicitDirectory: source.explicitDirectory as string }) }
      try {
        const fallbackDirectory = sample.explicitDirectory ?? await this.dependencies.resolveFallbackDirectory(sample)
        results.push(resolveDirectoryRule(config, { ...sample, fallbackDirectory, platform: this.platform }))
      } catch { return { ok: false, error: '无法读取当前默认目录以预览，请检查下载引擎后重试。' } }
    }
    return { ok: true, results }
  }
}
