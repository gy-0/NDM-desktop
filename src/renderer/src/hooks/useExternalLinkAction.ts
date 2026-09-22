import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openExternal } from '../lib/store'

/** Opening a source page must settle visibly, and only for the current link. */
export function useExternalLinkAction(url: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const pending = useRef(false)
  const initiator = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    sequence.current++
    pending.current = false
    initiator.current = null
    setBusy(false)
    setError('')
    return () => { sequence.current++ }
  }, [url])
  useEffect(() => {
    if (!busy && document.activeElement === document.body && initiator.current?.isConnected) {
      initiator.current.focus({ preventScroll: true })
    }
  }, [busy])
  const open = async (): Promise<void> => {
    if (!url || pending.current) return
    pending.current = true
    const request = ++sequence.current
    initiator.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true); setError('')
    try {
      if (!await openExternal(url) && request === sequence.current) setError('未能打开浏览器，请重试。')
    } catch {
      if (request === sequence.current) setError('未能打开浏览器，请重试。')
    } finally {
      if (request === sequence.current) { pending.current = false; setBusy(false) }
    }
  }
  return { open, busy, error }
}
