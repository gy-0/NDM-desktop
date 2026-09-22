import type { DownloadCategory } from './types'

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
    line: '深石墨底，冷蓝标记操作',
    note: '石墨表面保持安静，冷蓝标记操作与选中，文件类型各有一色。',
    background: '#111113'
  },
  {
    id: 'dawn',
    name: '雾昼',
    line: '柔和灰白，层级清晰',
    note: '灰白表面不偏黄也不偏蓝，类型色压深以保证可读。',
    background: '#f7f7f8'
  },
  {
    id: 'noon',
    name: '白昼',
    line: '纯净白色，信息优先',
    note: '真正的白色画布，以中性灰分层，色彩只落在信息上。',
    background: '#ffffff'
  }
]

export const DEFAULT_THEME: ThemeId = 'walnut'

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/** Category hues in display order, for palette previews. Values live in index.css. */
export const CATEGORY_HUE_ORDER: ReadonlyArray<DownloadCategory> = ['video', 'audio', 'document', 'compressed', 'application', 'image', 'misc']

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
