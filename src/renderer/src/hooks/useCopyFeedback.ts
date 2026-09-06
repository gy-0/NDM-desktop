import { useCallback, useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '../lib/store'
import { cue } from '../lib/sound'

const COPY_FEEDBACK_RESET_MS = 1500

export function useCopyFeedback(): readonly [copied: boolean, copy: (text: string, options?: { silent?: boolean }) => void] {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
  }, [])

  const copy = useCallback((text: string, options?: { silent?: boolean }): void => {
    void copyToClipboard(text).then(() => {
      if (!options?.silent) cue('success')
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)
    })
  }, [])

  return [copied, copy] as const
}