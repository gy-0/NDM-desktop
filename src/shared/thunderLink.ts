/**
 * Thunder wraps a URL as base64("AA" + URL + "ZZ"). Decode at the input
 * boundary so NDM's existing HTTP/HTTPS/FTP engines own the actual download.
 * This is a wrapper adapter, not a Thunder peer-to-peer transfer engine.
 */
export function decodeThunderLink(input: string): string | null {
  if (!/^thunder:\/\//i.test(input) || input.length > 32_768) return null
  const payload = input.slice('thunder://'.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  try {
    const binary = atob(payload)
    // Reject malformed padding/unused bits instead of silently repairing input.
    if (btoa(binary).replace(/=+$/, '') !== payload.replace(/=+$/, '')) return null
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, character => character.charCodeAt(0))
    )
    if (!decoded.startsWith('AA') || !decoded.endsWith('ZZ')) return null
    const target = decoded.slice(2, -2)
    if (!/^(?:https?|ftp):\/\//i.test(target) || /[\\\u0000-\u0020\u007f]/.test(target)) return null
    const url = new URL(target)
    if (!['http:', 'https:', 'ftp:'].includes(url.protocol) || !url.hostname) return null
    // Keep the original escaped path/query: normalization may invalidate a
    // signed download URL. Unsupported/nested wrappers never reach an engine.
    return target
  } catch {
    return null
  }
}
