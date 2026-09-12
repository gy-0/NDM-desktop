export type TemporaryBandwidthDuration = 15 | 30 | 60

export type TemporaryBandwidthSnapshot = {
  status: 'inactive' | 'checking' | 'active' | 'restoring'
  limitBytesPerSecond: number | null
  previousLimitBytesPerSecond: number | null
  expiresAt: number | null
  error?: string
}
