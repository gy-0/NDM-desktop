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

export function describeRelayStatus(status: RelayBridgeStatus | null, failed = false): {
  label: string; verified: boolean; detail: string | null
} {
  const result = (label: string, verified = false, detail: string | null = null) => ({ label, verified, detail })
  if (failed) return result('状态暂不可用')
  if (!status) return result('正在检查…')
  if (!status.available) return result('桥接未就绪')
  if (status.connectedClients === 0) return result('等待浏览器连接')
  if (!status.expectedRelayVersion || status.relayClients.length === 0) return result('已连接 · 版本未确认')
  if (status.relayClients.some(client => client.version !== status.expectedRelayVersion)) {
    const mixed = new Set(status.relayClients.map(client => client.version)).size > 1
    return result('扩展需要更新', false, mixed
      ? '检测到不同版本的扩展，请从当前应用的扩展目录重新加载旧版。'
      : '请从当前应用的扩展目录重新加载扩展。')
  }
  return result('已连接', true)
}
