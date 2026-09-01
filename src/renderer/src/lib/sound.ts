import { bind, play, setEnabled, setVolume, sounds, type SoundName } from 'cuelume'

const KEY = 'ndm-sound'
const VOLUME_KEY = 'ndm-sound-volume'
const DEFAULT_VOLUME = 0.58
const WARMUP_VOLUME = 0.0001

// Cuelume's recipes are intentionally expressive. Keep frequent feedback
// below the global preference so a fast sequence of clicks never turns into a
// wall of sharp transients; completion and reveal cues can still read clearly.
const CUE_LEVELS: Partial<Record<SoundName, number>> = {
  press: 0.42,
  release: 0.42,
  tick: 0.52,
  toggle: 0.46,
  page: 0.5,
  droplet: 0.56,
  bloom: 0.56,
  success: 0.68
}

let soundPrimed = false
let primerInstalled = false

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
  const on = soundEnabled()
  setEnabled(on)
  setVolume(soundVolume())
  if (!on || primeSoundOutput()) bind()
  else installSoundPrimer()
  return on
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  setEnabled(on)
  if (on) installSoundPrimer()
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
  play(name, { volume: CUE_LEVELS[name] ?? 0.5 })
}

function primeSoundOutput(): boolean {
  if (soundPrimed) return true
  if (typeof window === 'undefined' || navigator.userActivation?.hasBeenActive === false) return false
  play('press', { volume: WARMUP_VOLUME })
  soundPrimed = true
  return true
}

function installSoundPrimer(): void {
  if (primerInstalled || typeof document === 'undefined') return
  if (primeSoundOutput()) {
    bind()
    return
  }
  primerInstalled = true

  const primeFromGesture = (event: Event): void => {
    if (!primeSoundOutput()) return
    document.removeEventListener('pointerdown', primeFromGesture, true)
    document.removeEventListener('keydown', primeFromGesture, true)
    primerInstalled = false
    bind()

    if (event.type !== 'pointerdown' || !(event.target instanceof Element)) return
    const target = event.target.closest('[data-cuelume-press]')
    if (!target) return
    const requested = target.getAttribute('data-cuelume-press')
    const sound = sounds.includes(requested as SoundName) ? requested as SoundName : 'press'
    // The primer consumed this first pointerdown before cuelume was bound.
    // Replay its intended cue after the audio device has crossed the cold edge.
    window.setTimeout(() => play(sound), 32)
  }

  // Register before cuelume's delegated capture listeners so the first real
  // press can reuse a live context instead of paying the audio-device startup.
  document.addEventListener('pointerdown', primeFromGesture, true)
  document.addEventListener('keydown', primeFromGesture, true)
}
