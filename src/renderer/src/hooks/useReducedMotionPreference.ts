import { useSyncExternalStore } from 'react'

let preference: MediaQueryList | undefined
const listeners = new Set<() => void>()

function query(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  preference ??= window.matchMedia('(prefers-reduced-motion: reduce)')
  return preference
}

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  const media = query()
  listeners.add(listener)
  if (listeners.size === 1) media?.addEventListener('change', notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) media?.removeEventListener('change', notify)
  }
}

const getSnapshot = (): boolean => query()?.matches ?? true
const getServerSnapshot = (): boolean => true

/** One media listener for every control, with live OS preference updates. */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
