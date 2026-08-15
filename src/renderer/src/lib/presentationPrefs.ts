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
