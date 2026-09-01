import { useCallback, useEffect, useRef, useState } from 'react'
import {
  decideClipboardOffer,
  libraryHasClipboardUrl,
  resolveClipboardCandidate,
  type ClipboardTaskRef
} from './clipboardOffer'
import { readClipboardSnapshot } from './store'

export function useClipboardOffer(tasks: readonly ClipboardTaskRef[], composing: boolean) {
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const handledChangeCount = useRef<number | null>(null)
  const lastObservedChangeCount = useRef<number | null>(null)
  const pendingConsume = useRef(false)
  const clipboardUrlRef = useRef<string | null>(null)
  const composingRef = useRef(composing)
  const tasksRef = useRef(tasks)

  clipboardUrlRef.current = clipboardUrl
  composingRef.current = composing
  tasksRef.current = tasks

  const consumeGeneration = useCallback(async (): Promise<void> => {
    pendingConsume.current = true
    setClipboardUrl(null)
    try {
      const snapshot = await readClipboardSnapshot()
      handledChangeCount.current = snapshot.changeCount
      lastObservedChangeCount.current = snapshot.changeCount
    } finally {
      pendingConsume.current = false
    }
  }, [])

  const applySnapshot = useCallback(async (): Promise<void> => {
    const snapshot = await readClipboardSnapshot()
    if (pendingConsume.current) {
      handledChangeCount.current = snapshot.changeCount
      lastObservedChangeCount.current = snapshot.changeCount
      setClipboardUrl(null)
      return
    }
    const resolution = resolveClipboardCandidate(snapshot.text)
    const urlString = resolution?.urlString ?? null
    const decision = decideClipboardOffer({
      changeCount: snapshot.changeCount,
      handledChangeCount: handledChangeCount.current,
      lastObservedChangeCount: lastObservedChangeCount.current,
      urlString,
      inLibrary: urlString ? libraryHasClipboardUrl(tasksRef.current, urlString) : false,
      selfWritten: Boolean(snapshot.selfWritten),
      composerOpen: composingRef.current,
      offeredUrl: clipboardUrlRef.current
    })
    lastObservedChangeCount.current = snapshot.changeCount
    if (decision.kind === 'keep') return
    handledChangeCount.current = snapshot.changeCount
    setClipboardUrl(decision.kind === 'show' ? decision.urlString : null)
  }, [])

  const dismissOffer = useCallback((): void => {
    if (lastObservedChangeCount.current !== null) {
      handledChangeCount.current = lastObservedChangeCount.current
    }
    setClipboardUrl(null)
  }, [])

  useEffect(() => {
    const onFocus = (): void => {
      void applySnapshot()
    }
    window.addEventListener('focus', onFocus)
    void applySnapshot()
    return () => window.removeEventListener('focus', onFocus)
  }, [applySnapshot])

  useEffect(() => {
    if (!clipboardUrl) return
    if (libraryHasClipboardUrl(tasks, clipboardUrl)) setClipboardUrl(null)
  }, [clipboardUrl, tasks])

  return {
    clipboardUrl,
    consumeGeneration,
    dismissOffer
  }
}
