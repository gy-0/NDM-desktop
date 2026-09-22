export type RelayBridgeStatus = {
  available: boolean
  connectedClients: number
  expectedRelayVersion: string | null
  relayClients: Array<{ version: string; protocol: number; role: 'worker' }>
}

export function parseRelayBridgeStatus(reply: unknown): RelayBridgeStatus {
  const value = (reply as { bridge?: Partial<RelayBridgeStatus> } | null)?.bridge
  if (typeof value?.available !== 'boolean' || typeof value.connectedClients !== 'number'
    || !Number.isSafeInteger(value.connectedClients) || value.connectedClients < 0) {
    throw new Error('Missing bridge status')
  }
  return {
    available: value.available,
    connectedClients: value.connectedClients,
    expectedRelayVersion: typeof value.expectedRelayVersion === 'string' && value.expectedRelayVersion.trim()
      ? value.expectedRelayVersion : null,
    // Older hosts and unverified socket probes remain connected, but cannot prove a version.
    relayClients: Array.isArray(value.relayClients) ? value.relayClients.filter(client => client
      && client.role === 'worker' && typeof client.version === 'string' && client.version.trim()
      && client.protocol === 1) : []
  }
}

// Chrome compares up to four numeric components, padding omitted components with zero.
function versionParts(version: string): number[] | null {
  if (!/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version)) return null
  const parts = version.split('.').map(Number)
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) return null
  return Array.from({ length: 4 }, (_, index) => parts[index] ?? 0)
}

export function describeRelayStatus(status: RelayBridgeStatus | null, failed = false): {
  label: string; verified: boolean; detail: string | null
} {
  const result = (label: string, verified = false, detail: string | null = null) => ({ label, verified, detail })
  if (failed) return result('状态暂不可用')
  if (!status) return result('正在检查…')
  if (!status.available) return result('桥接未就绪')
  if (status.connectedClients === 0) return result('等待浏览器连接')
  const expected = status.expectedRelayVersion ? versionParts(status.expectedRelayVersion) : null
  if (!expected || status.relayClients.length === 0) return result('已连接 · 版本未确认')
  const versions = status.relayClients.map(client => versionParts(client.version))
  if (versions.some(version => !version)) return result('已连接 · 版本未确认')
  const directions = versions.map(version => {
    const index = version!.findIndex((part, index) => part !== expected[index])
    return index < 0 ? 0 : Math.sign(version![index] - expected[index])
  })
  const older = directions.includes(-1), newer = directions.includes(1)
  if (older && newer) return result('扩展版本不一致', false,
    '多个浏览器连接了不同版本的扩展。请先更新桌面端，再检查各浏览器中的 NDM Relay 更新。')
  if (older) return result('扩展需要更新', false, directions.includes(0)
    ? '检测到不同版本的扩展，请在对应浏览器中更新旧版 NDM Relay。'
    : '请在浏览器中检查 NDM Relay 更新，更新后重新打开浏览器连接。')
  if (newer) return result('扩展版本较新', false,
    '已连接的扩展比当前桌面端配套版本更新，请检查 NDM 桌面端更新。')
  return result('已连接', true)
}
