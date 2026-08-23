export type ProxyEndpoint = {
  host: string
  port: number
}

export type ProxyEndpointError = 'format' | 'ipv6Brackets' | 'port'

export type ProxyEndpointResult =
  | { ok: true; endpoint: ProxyEndpoint | null }
  | { ok: false; error: ProxyEndpointError }

export type ProxySettingsShape = {
  httpProxyHost?: string
  httpProxyPort?: number
  httpProxyEnabled?: boolean
  socksProxyHost?: string
  socksProxyPort?: number
  socksProxyEnabled?: boolean
}

export type ActiveProxyKind = 'http' | 'socks'

const invalidHostCharacters = /[\s/@?#\[\]]/

function validPort(value: string, defaultPort: number): number | null {
  if (!value) return defaultPort
  if (!/^\d+$/.test(value)) return null
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
}

export function parseProxyEndpoint(input: string, defaultPort: number): ProxyEndpointResult {
  const value = input.trim()
  if (!value) return { ok: true, endpoint: null }
  if (value.includes('://') || value.includes('@') || value.includes('/') || value.includes('?') || value.includes('#')) {
    return { ok: false, error: 'format' }
  }

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket <= 1) return { ok: false, error: 'format' }
    const host = value.slice(1, closingBracket)
    const suffix = value.slice(closingBracket + 1)
    if (!host.includes(':') || invalidHostCharacters.test(host) || (suffix && !suffix.startsWith(':'))) {
      return { ok: false, error: 'format' }
    }
    if (suffix === ':') return { ok: false, error: 'port' }
    const port = validPort(suffix ? suffix.slice(1) : '', defaultPort)
    return port == null
      ? { ok: false, error: 'port' }
      : { ok: true, endpoint: { host, port } }
  }

  const colonCount = [...value].filter((character) => character === ':').length
  if (colonCount > 1) return { ok: false, error: 'ipv6Brackets' }
  const separator = value.indexOf(':')
  const host = separator >= 0 ? value.slice(0, separator) : value
  const portText = separator >= 0 ? value.slice(separator + 1) : ''
  if (!host || invalidHostCharacters.test(host)) return { ok: false, error: 'format' }
  if (separator >= 0 && !portText) return { ok: false, error: 'port' }
  const port = validPort(portText, defaultPort)
  return port == null
    ? { ok: false, error: 'port' }
    : { ok: true, endpoint: { host, port } }
}

export function formatProxyEndpoint(host: string, port: number): string {
  const displayHost = host.includes(':') ? `[${host}]` : host
  return `${displayHost}:${port}`
}

export function formatProxyURL(scheme: 'http' | 'socks5', host: string, port?: number): string {
  const displayHost = host.includes(':') ? `[${host}]` : host
  return `${scheme}://${displayHost}${port ? `:${port}` : ''}`
}

export function activeProxyKind(settings: ProxySettingsShape): ActiveProxyKind | null {
  // Match the native engine's existing contract. A legacy settings file may
  // contain both flags, so SOCKS5 wins deterministically on every platform.
  if (settings.socksProxyEnabled && settings.socksProxyHost) return 'socks'
  if (settings.httpProxyEnabled && settings.httpProxyHost) return 'http'
  return null
}

export function preferredProxyURL(settings: ProxySettingsShape): string | undefined {
  const kind = activeProxyKind(settings)
  if (kind === 'socks' && settings.socksProxyHost) {
    return formatProxyURL('socks5', settings.socksProxyHost, settings.socksProxyPort)
  }
  if (kind === 'http' && settings.httpProxyHost) {
    return formatProxyURL('http', settings.httpProxyHost, settings.httpProxyPort)
  }
  return undefined
}
