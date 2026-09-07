import { useEffect, useState } from 'react'

export type ProgressStyle = 'segmented' | 'continuous'

const STORAGE_KEY = 'ndm-progress-style'
const CHANGE_EVENT = 'ndm-progress-style-change'

export function readProgressStyle(): ProgressStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'continuous' ? 'continuous' : 'segmented'
  } catch {
    return 'segmented'
  }
}

export function writeProgressStyle(style: ProgressStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style)
  } catch {
    // The current window still updates even when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<ProgressStyle>(CHANGE_EVENT, { detail: style }))
}

export function useProgressStyle(): ProgressStyle {
  const [style, setStyle] = useState(readProgressStyle)
  useEffect(() => {
    const onChange = (event: Event): void => setStyle((event as CustomEvent<ProgressStyle>).detail)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])
  return style
}

const EFFECTS_KEY = 'ndm-progress-effects'
const EFFECTS_EVENT = 'ndm-progress-effects-change'
export function readProgressEffects(): boolean {
  try { return localStorage.getItem(EFFECTS_KEY) !== 'off' } catch { return true }
}
export function writeProgressEffects(enabled: boolean): void {
  try { localStorage.setItem(EFFECTS_KEY, enabled ? 'on' : 'off') } catch { /* Keep the current window usable. */ }
  window.dispatchEvent(new CustomEvent(EFFECTS_EVENT, { detail: enabled }))
}
export function useProgressEffects(): boolean {
  const [enabled, setEnabled] = useState(readProgressEffects)
  useEffect(() => {
    const update = (event: Event): void => setEnabled((event as CustomEvent<boolean>).detail)
    window.addEventListener(EFFECTS_EVENT, update)
    return () => window.removeEventListener(EFFECTS_EVENT, update)
  }, [])
  return enabled
}
