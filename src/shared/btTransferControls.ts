import type { AuxiliaryPhase } from './auxiliaryTransfer'

// Wire schemas follow the pinned Aria2 Next RPC implementation. No Motrix
// implementation is copied: raw RPC strings are normalized at the engine edge.
export type BTEncryption = 'preferred' | 'required' | 'disabled'
// libtorrent's per-torrent upload_limit and the fork's seed-time seconds are
// signed 32-bit integers, even though JSON-RPC options are strings.
export const BT_MAX_UPLOAD_LIMIT = 2_147_483_647
export const BT_MAX_SEED_MINUTES = 35_791_394
export interface BTTrackerConfig { url: string; tier: number }
export interface BTTaskConfig {
  trackers: BTTrackerConfig[]
  webSeeds: string[]
  seedRatio: number
  seedMinutes: number | null
  uploadLimit: number
  peerExchange: boolean
}
export interface BTTracker extends BTTrackerConfig {
  status: string; failures: number; seeders: number; leechers: number
}
export interface BTPeer {
  ip: string; port: number; downloadSpeed: number; uploadSpeed: number
  progress: number; seeder: boolean; state: string; encryption: string
}
export interface BTControlsState {
  taskID: number; generation: number; revision: number; phase: AuxiliaryPhase
  config: BTTaskConfig; trackers: BTTracker[]; peers: BTPeer[]
}
export interface BTGlobalState { revision: number; encryption: BTEncryption; canConfigure: boolean }
export const BT_ERROR_MESSAGES = {
  invalidRequest: 'BT 操作参数无效，请重新读取任务。',
  invalidConfig: '请检查 Tracker、WebSeed 和分享策略的格式与范围。',
  invalidPeers: '请填写 IP:端口，IPv6 使用 [地址]:端口；每次最多 128 个。',
  notFound: '任务已不存在，请刷新任务列表。',
  unsupported: '当前引擎或任务不支持这项 BT 操作。',
  unavailable: '暂时无法读取 BT 引擎状态，请稍后重试。',
  staleGeneration: '任务已重新创建，请刷新后重新编辑。',
  conflict: '配置已由其他页面更新。编辑内容已保留，请读取最新配置后重新确认。',
  notPaused: '请先暂停 BT 任务，再修改配置或添加 peer。',
  allTasksMustPause: '修改会话加密前，请先暂停全部 BT 任务。',
  storage: '配置未能保存，请检查磁盘空间和文件权限。',
  unconfirmed: '操作结果尚未确认。编辑内容已保留，请刷新状态核对后重试。'
} as const
export type BTErrorCode = keyof typeof BT_ERROR_MESSAGES
export type BTFailure = { ok: false; code: BTErrorCode; error: string }
export type BTControlsReply = { ok: true; state: BTControlsState } | BTFailure
export type BTGlobalReply = { ok: true; state: BTGlobalState } | BTFailure
export type BTAddPeersReply = { ok: true; added: number; failed: number } | BTFailure

export const BT_CONTROL_OPS = ['auxiliaryBTStatus', 'auxiliaryBTConfigure', 'auxiliaryBTAddPeers', 'auxiliaryBTGlobalStatus', 'auxiliaryBTGlobalConfigure'] as const
export const isBTInteger = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
export const canConfigureBT = (phase: string): boolean => phase === 'paused' || phase === 'awaitingSelection'
const clean = (value: unknown, max = 8192): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0020\u007f-\u009f]/.test(value)
export const btObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('invalidRequest')
  return value as Record<string, unknown>
}
export const btOnly = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalidRequest')
}
export const isBTEncryption = (value: unknown): value is BTEncryption => ['preferred', 'required', 'disabled'].includes(value as string)

export function validateBTSourceURL(value: unknown, tracker = false): string {
  if (!clean(value) || !(tracker ? /^(?:https?|udp):\/\// : /^https?:\/\//).test(value)) throw new Error('invalidConfig')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('invalidConfig') }
  if (!url.hostname || url.hash || url.port && (!isBTInteger(Number(url.port), 1) || Number(url.port) > 65535)) throw new Error('invalidConfig')
  return value // Preserve signed paths and queries byte-for-byte.
}
export function validateBTTaskConfig(value: unknown): BTTaskConfig {
  const config = btObject(value)
  btOnly(config, ['trackers', 'webSeeds', 'seedRatio', 'seedMinutes', 'uploadLimit', 'peerExchange'])
  if (!Array.isArray(config.trackers) || config.trackers.length > 256 || !Array.isArray(config.webSeeds) || config.webSeeds.length > 128
      || typeof config.seedRatio !== 'number' || !Number.isFinite(config.seedRatio) || config.seedRatio < 0 || config.seedRatio > 1_000_000
      || config.seedMinutes !== null && (!isBTInteger(config.seedMinutes) || config.seedMinutes > BT_MAX_SEED_MINUTES)
      || !isBTInteger(config.uploadLimit) || config.uploadLimit > BT_MAX_UPLOAD_LIMIT || typeof config.peerExchange !== 'boolean') throw new Error('invalidConfig')
  const trackers: BTTrackerConfig[] = [], urls = new Set<string>()
  for (const raw of config.trackers) {
    const tracker = btObject(raw); btOnly(tracker, ['url', 'tier'])
    const url = validateBTSourceURL(tracker.url, true)
    if (!isBTInteger(tracker.tier) || tracker.tier > 255) throw new Error('invalidConfig')
    if (!urls.has(url)) { urls.add(url); trackers.push({ url, tier: tracker.tier }) }
  }
  // Aria2 Next compresses sparse tier numbers to consecutive ranks. Match that
  // behavior before admission so the saved intent and readback agree.
  const tiers = [...new Set(trackers.map(tracker => tracker.tier))].sort((left, right) => left - right)
  for (const tracker of trackers) tracker.tier = tiers.indexOf(tracker.tier)
  const webSeeds = [...new Set(config.webSeeds.map(url => validateBTSourceURL(url)))]
  return { trackers, webSeeds, seedRatio: config.seedRatio, seedMinutes: config.seedMinutes as number | null, uploadLimit: config.uploadLimit, peerExchange: config.peerExchange }
}
export function normalizeBTPeer(value: unknown): string {
  if (!clean(value, 80)) throw new Error('invalidPeers')
  const match = /^(\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i.exec(value)
  if (!match || !isBTInteger(Number(match[2]), 1) || Number(match[2]) > 65535) throw new Error('invalidPeers')
  if (match[1].startsWith('[')) {
    try { return `${new URL(`http://${match[1]}`).hostname}:${Number(match[2])}` } catch { throw new Error('invalidPeers') }
  }
  const octets = match[1].split('.').map(Number)
  if (octets.some(octet => octet > 255)) throw new Error('invalidPeers')
  return `${octets.join('.')}:${Number(match[2])}`
}
export function validateBTPeers(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 128) throw new Error('invalidPeers')
  return [...new Set(value.map(normalizeBTPeer))]
}
export function parseBTTrackerLines(value: string): BTTrackerConfig[] {
  if (value.length > 256 * 8200) throw new Error('invalidConfig')
  return value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^(?:(\d{1,3})\s+)?(\S+)$/.exec(line.trim())
    if (!match) throw new Error('invalidConfig')
    return { tier: match[1] ? Number(match[1]) : 0, url: validateBTSourceURL(match[2], true) }
  })
}
export const btConfigEqual = (left: BTTaskConfig, right: BTTaskConfig): boolean => JSON.stringify(left) === JSON.stringify(right)
export function btFailure(code: BTErrorCode): BTFailure { return { ok: false, code, error: BT_ERROR_MESSAGES[code] } }
export function btSafeFailure(reply: unknown, fallback: BTErrorCode = 'unavailable'): BTFailure {
  try { const code = btObject(reply).code; if (typeof code === 'string' && Object.hasOwn(BT_ERROR_MESSAGES, code)) return btFailure(code as BTErrorCode) } catch { /* fixed fallback only */ }
  return btFailure(fallback)
}

export function readBTControlsState(reply: unknown, taskID: number, generation: number): BTControlsState | null {
  try {
    const root = btObject(reply), state = btObject(root.state)
    if (root.ok !== true || state.taskID !== taskID || state.generation !== generation || !isBTInteger(taskID, 1) || !isBTInteger(generation)
        || !isBTInteger(state.revision) || !['metadata', 'awaitingSelection', 'checking', 'downloading', 'paused', 'seeding', 'complete', 'error', 'removed'].includes(state.phase as string)
        || !Array.isArray(state.trackers) || state.trackers.length > 256 || !Array.isArray(state.peers) || state.peers.length > 1000) return null
    const config = validateBTTaskConfig(state.config)
    const trackers = state.trackers.map(raw => {
      const item = btObject(raw), url = validateBTSourceURL(item.url, true)
      if (!isBTInteger(item.tier) || item.tier > 255 || !clean(item.status, 64)
          || ![item.failures, item.seeders, item.leechers].every(value => isBTInteger(value, -1))) throw new Error('invalid')
      return { url, tier: item.tier, status: item.status, failures: item.failures as number, seeders: item.seeders as number, leechers: item.leechers as number }
    })
    const peers = state.peers.map(raw => {
      const item = btObject(raw)
      if (!clean(item.ip, 64) || !isBTInteger(item.port, 1) || item.port > 65535 || !isBTInteger(item.downloadSpeed) || !isBTInteger(item.uploadSpeed)
          || typeof item.progress !== 'number' || !Number.isFinite(item.progress) || item.progress < 0 || item.progress > 1
          || typeof item.seeder !== 'boolean' || !clean(item.state, 32) || !clean(item.encryption, 32)) throw new Error('invalid')
      normalizeBTPeer(`${item.ip.includes(':') ? `[${item.ip}]` : item.ip}:${item.port}`)
      return { ip: item.ip, port: item.port, downloadSpeed: item.downloadSpeed, uploadSpeed: item.uploadSpeed, progress: item.progress, seeder: item.seeder, state: item.state, encryption: item.encryption }
    })
    return { taskID, generation, revision: state.revision, phase: state.phase as AuxiliaryPhase, config, trackers, peers }
  } catch { return null }
}
export function readBTGlobalState(reply: unknown): BTGlobalState | null {
  try {
    const root = btObject(reply), state = btObject(root.state)
    return root.ok === true && isBTInteger(state.revision) && isBTEncryption(state.encryption) && typeof state.canConfigure === 'boolean'
      ? { revision: state.revision, encryption: state.encryption, canConfigure: state.canConfigure } : null
  } catch { return null }
}
