import { isIP } from 'node:net'
import type { ProxySettingsShape } from '../../shared/proxyEndpoint'
import { AUXILIARY_ERROR_MESSAGES } from '../../shared/auxiliaryTransfer'

export type AuxiliaryProxyCode = 'proxyUnsupported' | 'proxyChanged' | 'proxyUnavailable' | 'proxyConfigurationUnsupported'
export class WindowsAuxiliaryProxyError extends Error {
  constructor(readonly code: AuxiliaryProxyCode) { super(AUXILIARY_ERROR_MESSAGES[code]) }
}
export interface WindowsAuxiliaryProxyPlan { kind: 'off' | 'http' | 'socks5'; url: string }
export function auxiliaryProxyPlan(settings: ProxySettingsShape): WindowsAuxiliaryProxyPlan {
  // An enabled but malformed proxy is an error, never permission for direct I/O.
  const kind = settings.socksProxyEnabled ? 'socks5' : settings.httpProxyEnabled ? 'http' : 'off'
  if (kind === 'off') {
    const legacy = settings as ProxySettingsShape & { httpsProxyEnabled?: boolean; ftpProxyEnabled?: boolean }
    if (legacy.httpsProxyEnabled || legacy.ftpProxyEnabled) throw new WindowsAuxiliaryProxyError('proxyConfigurationUnsupported')
    return { kind, url: '' }
  }
  const rawHost = kind === 'socks5' ? settings.socksProxyHost : settings.httpProxyHost
  const port = kind === 'socks5' ? settings.socksProxyPort : settings.httpProxyPort
  const host = typeof rawHost === 'string' ? rawHost.trim().replace(/^\[([^\]]+)\]$/, '$1') : ''
  if (!host || host.length > 253 || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535
      || (host.includes(':') ? isIP(host) !== 6 : !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host))) throw new WindowsAuxiliaryProxyError('proxyUnavailable')
  return { kind, url: `${kind}://${host.includes(':') ? `[${host}]` : host}:${port}/` }
}
export function assertAuxiliaryProxyProtocol(kind: string, proxy: WindowsAuxiliaryProxyPlan): void {
  if (kind === 'ed2k' && proxy.kind !== 'off') throw new WindowsAuxiliaryProxyError('proxyUnsupported')
}
export function auxiliaryProxyEnvironment(base: NodeJS.ProcessEnv, proxy: WindowsAuxiliaryProxyPlan): NodeJS.ProcessEnv {
  const result = { ...base }
  for (const key of Object.keys(result)) if (/^(?:http|https|ftp|sftp|all|no)_proxy$/i.test(key)) delete result[key]
  if (proxy.kind === 'socks5') result.ALL_PROXY = proxy.url.replace(/^socks5:/, 'socks5h:')
  return result
}

/** Readers remain concurrent. A proxy change waits for every prior operation,
 * then blocks new admissions/status/controls until the old child has exited.
 * This outer gate avoids reversing the existing task -> bandwidth lock order. */
export class WindowsProxyOperationGate {
  private barrier: Promise<void> = Promise.resolve()
  private readers = new Set<Promise<void>>()
  async run<T>(exclusive: boolean, action: () => Promise<T>): Promise<T> {
    const previous = this.barrier
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const readers = exclusive ? [...this.readers] : []
    if (exclusive) this.barrier = previous.then(() => Promise.all(readers)).then(() => done)
    else this.readers.add(done)
    await previous
    if (exclusive) await Promise.all(readers)
    try { return await action() } finally { release(); this.readers.delete(done) }
  }
}
