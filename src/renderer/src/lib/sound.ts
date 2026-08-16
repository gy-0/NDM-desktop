import { bind, play, setEnabled, setVolume, type SoundName } from 'cuelume'

const KEY = 'ndm-sound'
const VOLUME_KEY = 'ndm-sound-volume'
const DEFAULT_VOLUME = 0.82

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function initSound(): boolean {
  bind()
  const on = soundEnabled()
  setEnabled(on)
  setVolume(soundVolume())
  return on
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  setEnabled(on)
}

export function soundVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampVolume(stored) : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

export function setSoundVolume(value: number): void {
  const next = clampVolume(value)
  try {
    localStorage.setItem(VOLUME_KEY, String(next))
  } catch {
    /* ignore */
  }
  setVolume(next)
}

export function cue(name: SoundName): void {
  play(name)
}
