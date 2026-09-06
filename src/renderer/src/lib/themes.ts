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
    line: '中性石墨，专注克制',
    note: '纯石墨层级配少量鸢尾色，只强调真正的操作。',
    background: '#111113'
  },
  {
    id: 'dawn',
    name: '雾昼',
    line: '柔和灰白，层级清晰',
    note: '中性灰白表面，不偏黄，也不偏蓝。',
    background: '#f7f7f8'
  },
  {
    id: 'noon',
    name: '白昼',
    line: '纯净白色，信息优先',
    note: '真正的白色主画布，以中性灰建立层次。',
    background: '#ffffff'
  }
]

export const DEFAULT_THEME: ThemeId = 'walnut'

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

// ── Warm-copper (teak) accent candidate — "可切换的 accent 候选" ─────────────
// 任务约束:默认保持现有中性/accent 值,不要未经预览就全局换色。
// 这里只提供一个**编程式开关**(不接 UI):将来预览拍板后,把 `COPPER_ACCENT_ENABLED`
// 改为 `true` 并在 index.css 里开放 `[data-accent='teak']` 样式即可,无需再动本文件。
// 对比度已由 scripts/verify-theme-contrast.mjs 自证(见 docs/warm-copper-theme.md)。
export const COPPER_ACCENT_ENABLED = false

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
