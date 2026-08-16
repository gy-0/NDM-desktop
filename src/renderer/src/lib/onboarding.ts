const ONBOARDED_STORAGE_KEY = 'ndm.onboarded'

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDED_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
