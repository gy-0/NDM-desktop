export type RelayDistribution =
  | { mode: 'store'; url: string }
  | { mode: 'development' | 'unavailable'; url: null }

/** Only an explicit listing for our release may become the install destination. */
export function relayStoreURL(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const url = new URL(value.trim())
  if (url.origin !== 'https://chromewebstore.google.com' || url.username || url.password
    || url.search || url.hash || !/^\/detail\/(?:[a-z0-9-]+\/)?[a-p]{32}$/.test(url.pathname)) {
    throw new Error('NDM_RELAY_STORE_URL must be a Chrome Web Store listing URL without query or fragment')
  }
  return url.href
}

export function relayDistribution(packaged: boolean, configuredURL?: string): RelayDistribution {
  const url = relayStoreURL(configuredURL)
  return url ? { mode: 'store', url } : { mode: packaged ? 'unavailable' : 'development', url: null }
}
