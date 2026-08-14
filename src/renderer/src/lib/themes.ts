export type ThemeId = 'walnut' | 'dawn' | 'noon'

export interface Theme {
  id: ThemeId
  name: string
  line: string
  note: string
  background: string
}

export const THEMES: Theme[] = [
  {
    id: 'walnut',
    name: '胡桃夜',
    line: '深色，暖铜',
    note: '晚上用，或喜欢深色界面时用。',
    background: '#141210'
  },
  {
    id: 'dawn',
    name: '胡桃昼',
    line: '浅色，同一套风格',
    note: '和胡桃夜同一套字和颜色，只是亮一些。',
    background: '#f4efe6'
  },
  {
    id: 'noon',
    name: '白昼',
    line: '浅色，更素净',
    note: '界面更干净，颜色更少。',
    background: '#f5f4f0'
  }
]

export const DEFAULT_THEME: ThemeId = 'walnut'

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem('ndm-theme')
    if (THEMES.some((theme) => theme.id === stored)) return stored as ThemeId
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME
}

export function writeStoredTheme(id: ThemeId): void {
  try {
    localStorage.setItem('ndm-theme', id)
  } catch {
    /* ignore */
  }
}
