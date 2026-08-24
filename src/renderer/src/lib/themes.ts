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
    name: '墨夜',
    line: '中性石墨，低干扰',
    note: '减少色偏与眩光，适合长时间使用。',
    background: '#101114'
  },
  {
    id: 'dawn',
    name: '雾昼',
    line: '柔和灰白，层级清晰',
    note: '保留纸面柔和感，不带黄色滤镜。',
    background: '#f1f1ef'
  },
  {
    id: 'noon',
    name: '白昼',
    line: '冷静明亮，信息优先',
    note: '对比更明确，适合明亮环境。',
    background: '#f5f6f7'
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
