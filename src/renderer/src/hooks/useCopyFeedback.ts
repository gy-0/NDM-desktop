import { useCallback, useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '../lib/store'
import { cue } from '../lib/sound'

const COPY_FEEDBACK_RESET_MS = 1500

export function useCopyFeedback(): readonly [copied: boolean, copy: (text: string, options?: { silent?: boolean }) => void, error: string] {
  const [error, setError] = useState('')
  const generation = useRef(0)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    generation.current++
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
  }, [])

  const copy = useCallback((text: string, options?: { silent?: boolean }): void => {
    const request = ++generation.current
    setCopied(false)
    setError('')
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    void copyToClipboard(text).then(() => {
      if (request !== generation.current) return
      if (!options?.silent) cue('success')
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)
    }).catch(() => {
      if (request === generation.current) setError('复制失败，请重试')
    })
  }, [])

  return [copied, copy, error] as const
}