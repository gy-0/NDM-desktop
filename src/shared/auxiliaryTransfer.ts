import { isDirectoryForPlatform, type DirectoryRulesPlatform } from './directoryRules'

export type AuxiliaryProtocol = 'magnet' | 'torrent' | 'ed2k' | 'sftp'
export type AuxiliaryKind = 'bittorrent' | 'ed2k' | 'sftp'
export type AuxiliaryPhase = 'metadata' | 'awaitingSelection' | 'checking' | 'downloading' | 'paused' | 'seeding' | 'complete' | 'error' | 'removed'
export interface AuxiliaryCapabilities { bittorrent: boolean; ed2k: boolean; sftp: boolean; fileSelection: boolean; stopSeeding: boolean }
export type AuxiliarySource = { kind: 'magnet' | 'ed2k'; url: string } | { kind: 'torrent'; token: string } | { kind: 'sftp'; url: string; hostKeySHA256: string }
export interface AuxiliaryCreateRequest { creationKey: string; source: AuxiliarySource; credentials?: { username: string; password: string }; folderPath?: string; autoStart: boolean }
export interface AuxiliaryFile { index: number; relativePath: string; length: number; completedLength: number; selected: boolean }
export interface AuxiliarySnapshot {
  taskID: number; generation: number; kind: AuxiliaryKind; phase: AuxiliaryPhase
  totalBytes: number; completedBytes: number; downloadSpeed: number; uploadSpeed: number
  payloadCompleted: boolean
  uploadedBytes?: number; ratio?: number; files: AuxiliaryFile[]; errorCode?: string
}
export const AUXILIARY_PHASE_LABELS: Record<AuxiliaryPhase, string> = {
  metadata: '正在读取元数据', awaitingSelection: '等待选择文件', checking: '正在校验', downloading: '正在下载',
  paused: '已暂停', seeding: '正在做种', complete: '已完成', error: '任务出错', removed: '任务已移除'
}
export const AUXILIARY_ERROR_MESSAGES: Record<string, string> = {
  unavailable: '辅助下载引擎暂不可用，请检查引擎安装和运行状态。', unsupported: '当前引擎不支持所选协议。',
  invalidSource: '下载来源无效，请检查链接或重新选择种子文件。', hostPinRequired: '请填写服务器公钥的 SHA-256 指纹。',
  hostKeyMismatch: '服务器公钥与填写的指纹不一致，连接已停止。请向服务器管理员核实指纹。',
  credentialsRequired: '请提供 SFTP 用户名和密码。', authenticationFailed: 'SFTP 身份验证失败，请核对账号密码。',
  invalidSelection: '文件选择与当前元数据不一致，请重新读取任务。', selectionRequired: '至少选择一个文件后才能开始下载。',
  staleGeneration: '任务已更新，请重新读取后操作。', notFound: '任务已不存在，请检查任务列表。',
  receiptUnavailable: '暂时无法核对创建回执，请稍后重试。', storage: '任务记录未能保存，请检查磁盘空间和文件权限。',
  invalidRequest: '参数未能通过验证，任务尚未提交。请修改后重试。'
}
/** Never reflect arbitrary RPC messages, source URLs or credentials into errors. */
export function auxiliaryErrorMessage(reply: unknown, fallback = '操作未能确认，请检查下载引擎后重试。'): string {
  const code = reply && typeof reply === 'object' && 'code' in reply ? (reply as { code?: unknown }).code : undefined
  return typeof code === 'string' && Object.hasOwn(AUXILIARY_ERROR_MESSAGES, code) ? AUXILIARY_ERROR_MESSAGES[code] : fallback
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('协议参数格式无效。')
  return value as Record<string, unknown>
}
const only = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('协议参数包含不支持的字段。') }
const whole = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const controls = /[\u0000-\u001f\u007f-\u009f]/
const keyPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i

export function normalizeSFTPHostPin(value: string): string | null {
  const pin = value.trim().replace(/^SHA256:/, '')
  if (!/^[A-Za-z\d+/]{43}=?$/.test(pin)) return null
  try {
    const decoded = atob(pin.endsWith('=') ? pin : `${pin}=`)
    if (decoded.length !== 32 || btoa(decoded).replace(/=+$/, '') !== pin.replace(/=+$/, '')) return null
    return `SHA256:${pin.replace(/=+$/, '')}`
  } catch { return null }
}

export function validateAuxiliaryCreate(value: unknown, platform: DirectoryRulesPlatform): AuxiliaryCreateRequest {
  const input = object(value)
  only(input, ['creationKey', 'source', 'credentials', 'folderPath', 'autoStart'])
  if (typeof input.creationKey !== 'string' || !keyPattern.test(input.creationKey) || typeof input.autoStart !== 'boolean') throw new Error('任务标识或创建方式无效。')
  if (input.folderPath !== undefined && (typeof input.folderPath !== 'string' || !isDirectoryForPlatform(input.folderPath, platform))) throw new Error('请选择当前系统的绝对目标目录。')
  const raw = object(input.source)
  let source: AuxiliarySource
  if (raw.kind === 'torrent') {
    only(raw, ['kind', 'token'])
    if (typeof raw.token !== 'string' || !/^[a-z\d_-]{16,128}$/i.test(raw.token)) throw new Error('请通过文件选择器重新选择种子文件。')
    source = { kind: 'torrent', token: raw.token }
  } else {
    only(raw, raw.kind === 'sftp' ? ['kind', 'url', 'hostKeySHA256'] : ['kind', 'url'])
    if (typeof raw.url !== 'string' || !raw.url || raw.url.length > 65536 || controls.test(raw.url)) throw new Error('协议链接无效或过长。')
    const url = raw.url.trim()
    if (raw.kind === 'magnet') {
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new Error('请输入有效的磁力链接。') }
      if (!url.startsWith('magnet:?') || /\s/.test(url) || !parsed.searchParams.getAll('xt').some(value => /^urn:(?:btih:(?:[a-f\d]{40}|[a-z2-7]{32})|btmh:1220[a-f\d]{64})$/i.test(value))) throw new Error('磁力链接必须包含有效的 BTIH 或 BTMH 标识。')
      source = { kind: 'magnet', url }
    } else if (raw.kind === 'ed2k') {
      const match = /^ed2k:\/\/\|file\|([^|]+)\|(\d+)\|([a-f\d]{32})\|(?:(?:\/\|)?sources,([^|]+)\|)?\/$/i.exec(url)
      if (!match || !whole(Number(match[2]))) throw new Error('请输入标准的 ED2K 文件链接。')
      if (match[4]) {
        const peers = match[4].split(',')
        if (peers.length > 32 || peers.some(peer => {
          const endpoint = /^([a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?):(\d{1,5})$/i.exec(peer)
          if (!endpoint || !whole(Number(endpoint[2]), 1) || Number(endpoint[2]) > 65535) return true
          const host = endpoint[1]
          if (host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return true
          return /^[\d.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(octet => Number(octet) > 255))
        })) throw new Error('ED2K 来源最多支持 32 个有效的主机与端口。')
      }
      let filename = match[1]
      try { filename = decodeURIComponent(filename) } catch { throw new Error('ED2K 文件名编码无效。') }
      if (!filename || /[/\\]/.test(filename) || controls.test(filename) || filename === '.' || filename === '..') throw new Error('ED2K 文件名无效。')
      source = { kind: 'ed2k', url }
    } else if (raw.kind === 'sftp') {
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new Error('请输入有效的 SFTP 文件地址。') }
      if (!url.startsWith('sftp://') || /[\s\\]/.test(url) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname || parsed.pathname === '/') throw new Error('SFTP 地址只填写主机和文件路径，账号密码请填写在独立输入框。')
      const hostKeySHA256 = typeof raw.hostKeySHA256 === 'string' ? normalizeSFTPHostPin(raw.hostKeySHA256) : null
      if (!hostKeySHA256) throw new Error('请填写有效的 SHA256:Base64 主机公钥指纹。')
      source = { kind: 'sftp', url, hostKeySHA256 }
    } else throw new Error('请在普通下载入口添加 HTTP、HTTPS 或 FTP 链接。')
  }
  if ((source.kind === 'magnet' || source.kind === 'torrent') && input.autoStart) throw new Error('BT 任务需要先读取元数据并选择文件。')
  let credentials: AuxiliaryCreateRequest['credentials']
  if (source.kind === 'sftp') {
    const login = object(input.credentials)
    only(login, ['username', 'password'])
    if (typeof login.username !== 'string' || !login.username.trim() || login.username.length > 256 || controls.test(login.username)
        || typeof login.password !== 'string' || !login.password.length || login.password.length > 4096 || login.password.includes('\0')) throw new Error('请填写有效的 SFTP 用户名和密码。')
    credentials = { username: login.username, password: login.password }
  } else if (input.credentials !== undefined) throw new Error('此协议不接受账号密码参数。')
  return { creationKey: input.creationKey, source, autoStart: input.autoStart,
    ...(input.folderPath === undefined ? {} : { folderPath: input.folderPath as string }), ...(credentials ? { credentials } : {}) }
}

export function auxiliarySourceLabel(source: AuxiliarySource): string {
  if (source.kind === 'sftp') {
    try { const url = new URL(source.url); return `SFTP · ${url.hostname}${url.port ? `:${url.port}` : ''}` } catch { return 'SFTP' }
  }
  return source.kind === 'torrent' ? '本地种子文件' : source.kind === 'magnet' ? '磁力链接' : 'ED2K 文件链接'
}
export function readAuxiliaryCapabilities(reply: unknown): AuxiliaryCapabilities | null {
  try {
    const root = object(reply), value = object(root.capabilities)
    if (root.ok !== true || ['bittorrent', 'ed2k', 'sftp', 'fileSelection', 'stopSeeding'].some(key => typeof value[key] !== 'boolean')) return null
    return { bittorrent: value.bittorrent as boolean, ed2k: value.ed2k as boolean, sftp: value.sftp as boolean, fileSelection: value.fileSelection as boolean, stopSeeding: value.stopSeeding as boolean }
  } catch { return null }
}
export function supportsAuxiliaryProtocol(capabilities: AuxiliaryCapabilities, protocol: AuxiliaryProtocol): boolean {
  return protocol === 'magnet' || protocol === 'torrent' ? capabilities.bittorrent && capabilities.fileSelection : capabilities[protocol]
}

export function readAuxiliarySnapshot(reply: unknown, expectedTaskID: number): AuxiliarySnapshot | null {
  try {
    const root = object(reply), value = object(root.snapshot)
    if (root.ok !== true || value.taskID !== expectedTaskID || !whole(value.taskID, 1) || !whole(value.generation)
        || !['bittorrent', 'sftp', 'ed2k'].includes(value.kind as string) || !Object.hasOwn(AUXILIARY_PHASE_LABELS, String(value.phase))
        || !['totalBytes', 'completedBytes', 'downloadSpeed', 'uploadSpeed'].every(key => whole(value[key]))
        || (Number(value.completedBytes) > Number(value.totalBytes) && !(value.totalBytes === 0 && value.phase !== 'complete' && value.payloadCompleted === false)) || typeof value.payloadCompleted !== 'boolean'
        || (value.phase === 'complete' && !value.payloadCompleted) || !Array.isArray(value.files) || value.files.length > 100000) return null
    const indices = new Set<number>(), paths = new Set<string>()
    const files: AuxiliaryFile[] = value.files.map(raw => {
      const file = object(raw)
      if (!whole(file.index, 1) || indices.has(file.index) || typeof file.relativePath !== 'string' || !file.relativePath
          || file.relativePath.length > 4096 || controls.test(file.relativePath) || /[\\:]/.test(file.relativePath)
          || file.relativePath.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.relativePath)
          || !whole(file.length) || !whole(file.completedLength) || (file.completedLength > file.length && !(file.length === 0 && value.phase !== 'complete' && value.payloadCompleted === false)) || typeof file.selected !== 'boolean') throw new Error('manifest')
      indices.add(file.index); paths.add(file.relativePath)
      return { index: file.index, relativePath: file.relativePath, length: file.length, completedLength: file.completedLength, selected: file.selected }
    })
    return { taskID: expectedTaskID, generation: value.generation, kind: value.kind as AuxiliaryKind, phase: value.phase as AuxiliaryPhase,
      totalBytes: value.totalBytes as number, completedBytes: value.completedBytes as number, downloadSpeed: value.downloadSpeed as number, uploadSpeed: value.uploadSpeed as number,
      ...(whole(value.uploadedBytes) ? { uploadedBytes: value.uploadedBytes } : {}),
      ...(typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= 0 ? { ratio: value.ratio } : {}),
      payloadCompleted: value.payloadCompleted, files, ...(typeof value.errorCode === 'string' && /^\d{1,4}$/.test(value.errorCode) ? { errorCode: value.errorCode } : {}) }
  } catch { return null }
}

export function auxiliarySelectionRequest(snapshot: AuxiliarySnapshot, indices: number[], autoStart: boolean): { taskID: number; generation: number; indices: number[]; autoStart: boolean } {
  if (snapshot.kind !== 'bittorrent' || !['paused', 'awaitingSelection'].includes(snapshot.phase)) throw new Error('请先暂停任务并重新读取状态，再修改文件选择。')
  const manifest = new Set(snapshot.files.map(file => file.index))
  if (typeof autoStart !== 'boolean' || !indices.length || indices.length > manifest.size || new Set(indices).size !== indices.length || indices.some(index => !whole(index, 1) || !manifest.has(index))) throw new Error('请至少选择清单中的一个文件。')
  return { taskID: snapshot.taskID, generation: snapshot.generation, indices: [...indices].sort((a, b) => a - b), autoStart }
}

export type AuxiliaryCreationState = { phase: 'unconfirmed' | 'accepted' | 'rejected'; creationKey: string; label: string; taskID?: number; message?: string }
export type AuxiliaryRequester = (op: string, extra: Record<string, unknown>) => Promise<unknown>
/** One volatile creation intent survives panel remounts. No credentials are
 * written to browser storage or a composer draft. The main process owns receipts. */
export class AuxiliaryCreationController {
  private intent: AuxiliaryCreateRequest | null
  private state: AuxiliaryCreationState
  private queue: Promise<unknown> = Promise.resolve()
  constructor(request: AuxiliaryCreateRequest, private readonly transport: AuxiliaryRequester) {
    this.intent = structuredClone(request)
    this.state = { phase: 'unconfirmed', creationKey: request.creationKey, label: auxiliarySourceLabel(request.source) }
  }
  snapshot(): AuxiliaryCreationState { return { ...this.state } }
  private finish(taskID: unknown): boolean {
    if (!whole(taskID, 1)) return false
    this.state = { phase: 'accepted', creationKey: this.state.creationKey, label: this.state.label, taskID }
    this.intent = null // Forget the password immediately after durable acknowledgement.
    return true
  }
  /** Initial and subsequent submissions both query the durable receipt first. */
  reconcile(retry = false): Promise<AuxiliaryCreationState> {
    const result = this.queue.then(async () => {
      if (this.state.phase !== 'unconfirmed') return this.snapshot()
      let absent = false
      try {
        const raw = await this.transport('getCreationReceipt', { creationKey: this.state.creationKey })
        const reply = object(raw)
        if (reply.ok === true && reply.receipt && this.finish(object(reply.receipt).taskID)) return this.snapshot()
        absent = reply.ok === true && reply.receipt === null && reply.pending !== true
        this.state.message = absent ? '尚未查到创建回执，可重试同一次请求。' : '任务仍在处理或回执暂不可用，请稍后核对。'
      } catch { this.state.message = AUXILIARY_ERROR_MESSAGES.receiptUnavailable }
      if (!retry || !absent || !this.intent) return this.snapshot()
      try {
        const raw = await this.transport('auxiliaryCreate', structuredClone(this.intent) as unknown as Record<string, unknown>)
        const reply = object(raw)
        const receipt = reply.receipt && typeof reply.receipt === 'object' ? reply.receipt as { taskID?: unknown } : undefined
        const task = reply.task && typeof reply.task === 'object' ? reply.task as { id?: unknown } : undefined
        if (reply.ok === true && this.finish(reply.taskID ?? receipt?.taskID ?? task?.id)) return this.snapshot()
        if (reply.ok === false && reply.code === 'invalidRequest') {
          // Main guarantees this rejection occurs before engine dispatch.
          this.state = { ...this.state, phase: 'rejected', message: AUXILIARY_ERROR_MESSAGES.invalidRequest }
          this.intent = null
          return this.snapshot()
        }
        this.state.message = auxiliaryErrorMessage(raw, '创建回执尚未确认。请核对原操作，不要重复新建。')
      } catch { this.state.message = '创建回执尚未确认。请核对原操作，不要重复新建。' }
      return this.snapshot()
    })
    this.queue = result.catch(() => undefined)
    return result
  }
}
