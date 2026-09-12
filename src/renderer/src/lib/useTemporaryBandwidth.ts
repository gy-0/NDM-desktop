import { useCallback, useEffect, useRef, useState } from 'react'
import type { TemporaryBandwidthDuration, TemporaryBandwidthSnapshot } from '../../../shared/temporaryBandwidth'

const EMPTY: TemporaryBandwidthSnapshot = { status: 'inactive', limitBytesPerSecond: null, previousLimitBytesPerSecond: null, expiresAt: null }
const valid = (value: unknown): value is TemporaryBandwidthSnapshot => Boolean(value && typeof value === 'object' && 'status' in value && ['inactive', 'checking', 'active', 'restoring'].includes(String(value.status)))

/** The main process owns the timer and restoration; closing a panel changes neither. */
export function useTemporaryBandwidth(enabled = true) {
  const [snapshot, setSnapshot] = useState<TemporaryBandwidthSnapshot>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.ndm?.request('temporaryBandwidthStatus', { refresh: true })
      if (mounted.current && valid(next)) setSnapshot(next)
    } catch { /* The existing engine status communicates connection loss. */ }
  }, [])

  useEffect(() => {
    if (!enabled) return
    mounted.current = true
    const offEvent = window.ndm?.onEvent(message => {
      if (message.op === 'temporaryBandwidthChanged' && valid(message.session)) setSnapshot(message.session)
    })
    const offStatus = window.ndm?.onStatus(status => { if (status.status === 'live') void refresh() })
    void refresh()
    return () => { mounted.current = false; offEvent?.(); offStatus?.() }
  }, [enabled, refresh])

  const run = useCallback(async (op: string, extra: Record<string, unknown>): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const next = await window.ndm?.request(op, extra)
      if (!valid(next)) throw new Error('Unconfirmed bandwidth operation')
      if (mounted.current) setSnapshot(next)
      return true
    } catch {
      if (mounted.current) setError(op === 'startTemporaryBandwidth' ? '未能设置临时限速，请重试。' : '未能恢复原限速，请重试。')
      await refresh()
      return false
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }, [refresh])

  return {
    snapshot, busy, error, refresh,
    apply: (limit: number, minutes: TemporaryBandwidthDuration) => run('startTemporaryBandwidth', { limitBytesPerSecond: limit, minutes }),
    restore: () => run('restoreTemporaryBandwidth', {})
  }
}
