import { bind, play, setEnabled, setVolume, type SoundName } from 'cuelume'

const KEY = 'ndm-sound'

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
  setVolume(0.42)
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

export function cue(name: SoundName): void {
  play(name)
}
