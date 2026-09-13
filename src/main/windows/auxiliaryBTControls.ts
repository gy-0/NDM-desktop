import { lstat, readFile } from 'node:fs/promises'
import { writeAtomicWindowsState } from './creationReceipts'
import { type WindowsAuxiliaryRPC } from './auxiliaryRpc'
import { validateBTTaskConfig, readBTControlsState, isBTEncryption, type BTTaskConfig, type BTControlsState, type BTEncryption, type BTGlobalState } from '../../shared/btTransferControls'
import type { AuxiliarySnapshot } from '../../shared/auxiliaryTransfer'

export type BTTaskRecord = { revision: number; config: BTTaskConfig; pending?: { revision: number; config: BTTaskConfig } }
export const btOptionValues = (config: BTTaskConfig): Record<string, string> => ({ 'seed-ratio': String(config.seedRatio), ...(config.seedMinutes === null ? {} : { 'seed-time': String(config.seedMinutes) }), 'max-upload-limit': String(config.uploadLimit), 'enable-peer-exchange': String(config.peerExchange) })
const numeric = (value: unknown, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' && typeof value !== 'number' || !/^-?\d+(?:\.\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) throw new Error('unconfirmed')
  return Number(value)
}
const boolean = (value: unknown): boolean => { if (value === 'true' || value === true) return true; if (value === 'false' || value === false) return false; throw new Error('unconfirmed') }
export async function readRuntimeBTConfig(rpc: WindowsAuxiliaryRPC, gid: string): Promise<BTTaskConfig> {
  const [status, options] = await Promise.all([rpc.call<any>('aria2.tellStatus', [gid]), rpc.call<Record<string, string>>('aria2.getOption', [gid])])
  if (status?.gid !== gid || !status.bittorrent || !Array.isArray(status.bittorrent.announceList) || !Array.isArray(status.bittorrent.webSeeds)) throw new Error('unconfirmed')
  const trackers = status.bittorrent.announceList.flatMap((urls: unknown, tier: number) => { if (!Array.isArray(urls)) throw new Error('unconfirmed'); return urls.map(url => ({ url, tier })) })
  return validateBTTaskConfig({ trackers, webSeeds: status.bittorrent.webSeeds, seedRatio: numeric(options['seed-ratio'], 1), seedMinutes: options['seed-time'] === undefined ? null : numeric(options['seed-time']), uploadLimit: numeric(options['max-upload-limit'], 0), peerExchange: options['enable-peer-exchange'] === undefined ? true : boolean(options['enable-peer-exchange']) })
}
export const equivalentBTConfig = (left: BTTaskConfig, right: BTTaskConfig): boolean => {
  const canonical = (config: BTTaskConfig) => JSON.stringify({ ...config, trackers: [...config.trackers].sort((a,b) => a.tier - b.tier || a.url.localeCompare(b.url)), webSeeds: [...config.webSeeds].sort() })
  return canonical(left) === canonical(right)
}
export async function applyRuntimeBTConfig(rpc: WindowsAuxiliaryRPC, gid: string, config: BTTaskConfig): Promise<void> {
  await rpc.call('aria2.changeOption', [gid, btOptionValues(config)])
  if (await rpc.call('aria2.replaceBtTrackers', [gid, config.trackers]) !== gid || await rpc.call('aria2.replaceBtWebSeeds', [gid, config.webSeeds]) !== gid) throw new Error('unconfirmed')
  // getBtTrackers is connection telemetry and can remain empty while paused;
  // announceList is the authoritative tracker configuration readback.
  if (!equivalentBTConfig(await readRuntimeBTConfig(rpc, gid), config)) throw new Error('unconfirmed')
}
export async function readBTState(rpc: WindowsAuxiliaryRPC, gid: string, snapshot: AuxiliarySnapshot, record: BTTaskRecord): Promise<BTControlsState> {
  const [trackers, peers] = await Promise.all([rpc.call<any[]>('aria2.getBtTrackers', [gid]), rpc.call<any[]>('aria2.getPeers', [gid])])
  if (!Array.isArray(trackers) || !Array.isArray(peers)) throw new Error('unavailable')
  const state = readBTControlsState({ ok: true, state: { taskID: snapshot.taskID, generation: snapshot.generation, revision: record.revision, phase: snapshot.phase, config: record.config,
    trackers: trackers.map(item => ({ url: item.url, tier: numeric(item.tier), status: item.status, failures: numeric(item.failures), seeders: numeric(item.seeders), leechers: numeric(item.leechers) })),
    peers: peers.map(item => ({ ip: item.ip, port: numeric(item.port), downloadSpeed: numeric(item.downloadSpeed), uploadSpeed: numeric(item.uploadSpeed), progress: numeric(item.progress), seeder: boolean(item.seeder), state: item.state, encryption: item.encryption })) } }, snapshot.taskID, snapshot.generation)
  if (!state) throw new Error('unavailable')
  return state
}

type GlobalRecord = { version: 1; revision: number; encryption: BTEncryption; pending?: { revision: number; encryption: BTEncryption } }
/** One actual libtorrent session setting; no per-task getOption imitation. */
export class WindowsBTGlobalConfiguration {
  private record?: GlobalRecord
  constructor(private readonly path: string) {}
  private async load(): Promise<GlobalRecord> {
    if (this.record) return this.record
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('storage')
      const value = JSON.parse(await readFile(this.path, 'utf8')) as GlobalRecord
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isBTEncryption(value.encryption)
        || value.pending && (value.pending.revision !== value.revision + 1 || !isBTEncryption(value.pending.encryption))) throw new Error('storage')
      return this.record = value
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('storage'); return this.record = { version: 1, revision: 0, encryption: 'preferred' } }
  }
  private async save(value: GlobalRecord): Promise<void> { try { await writeAtomicWindowsState(this.path, JSON.stringify(value)); this.record = value } catch { throw new Error('storage') } }
  async startupEncryption(): Promise<BTEncryption> { const value = await this.load(); return value.pending?.encryption ?? value.encryption }
  async status(rpc: WindowsAuxiliaryRPC, canConfigure: boolean): Promise<BTGlobalState> {
    let value = await this.load()
    const actual = (await rpc.call<Record<string, string>>('aria2.getGlobalOption'))['bt-encryption']
    if (value.pending) {
      if (actual !== value.pending.encryption) {
        if (!canConfigure) throw new Error('allTasksMustPause')
        await rpc.call('aria2.changeGlobalOption', [{ 'bt-encryption': value.pending.encryption }])
        if ((await rpc.call<Record<string, string>>('aria2.getGlobalOption'))['bt-encryption'] !== value.pending.encryption) throw new Error('unconfirmed')
      }
      value = { version: 1, revision: value.pending.revision, encryption: value.pending.encryption }
      await this.save(value)
    } else if (actual !== value.encryption) throw new Error('unconfirmed')
    return { revision: value.revision, encryption: value.encryption, canConfigure }
  }
  async configure(rpc: WindowsAuxiliaryRPC, expectedRevision: number, encryption: BTEncryption, canConfigure: boolean): Promise<BTGlobalState> {
    const state = await this.status(rpc, canConfigure)
    if (state.revision !== expectedRevision) throw new Error('conflict')
    if (!canConfigure) throw new Error('allTasksMustPause')
    if (state.encryption === encryption) return state
    await this.save({ ...(await this.load()), pending: { revision: state.revision + 1, encryption } })
    return this.status(rpc, canConfigure)
  }
}
