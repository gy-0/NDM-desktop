import { Check } from 'lucide-react'
import { CATEGORY_LABEL } from '../lib/types'
import { CATEGORY_HUE_ORDER, type Theme } from '../lib/themes'
import './ui/theme-preview.css'

/**
 * A miniature of the real workspace rendered with the theme's own tokens.
 * `data-theme` on the card scopes every custom property from index.css, so
 * this is the appearance itself at 1:6, not an illustration of it.
 */
export function ThemePreviewCard({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" data-cuelume-toggle aria-pressed={selected} onClick={onSelect} className="theme-card" data-selected={selected || undefined}>
      <span className="theme-card-canvas" data-theme={theme.id} aria-hidden>
        <span className="theme-card-sidebar">
          <span className="theme-card-brand">NDM</span>
          <span className="theme-card-nav" data-active />
          <span className="theme-card-nav" />
          <span className="theme-card-nav" />
          <span className="theme-card-nav-hues">
            {CATEGORY_HUE_ORDER.slice(0, 4).map(category => <i key={category} data-category={category} />)}
          </span>
        </span>
        <span className="theme-card-main">
          <span className="theme-card-hero">
            <i className="theme-card-mark" data-category="compressed" />
            <span className="theme-card-lines"><i /><i /></span>
            <span className="theme-card-progress"><i /></span>
          </span>
          <span className="theme-card-row"><i className="theme-card-mark" data-category="video" /><i className="theme-card-line" /></span>
          <span className="theme-card-row"><i className="theme-card-mark" data-category="document" /><i className="theme-card-line" /></span>
          <span className="theme-card-row"><i className="theme-card-mark" data-category="audio" /><i className="theme-card-line" /></span>
        </span>
      </span>
      <span className="theme-card-caption">
        <span className="theme-card-name">{theme.name}</span>
        <span className="theme-card-line-copy">{theme.line}</span>
      </span>
      <span className="theme-card-check" aria-hidden><Check size={11} strokeWidth={2.4} /></span>
    </button>
  )
}

/** The category palette as it reads in the current theme. */
export function CategoryHueStrip() {
  return (
    <ul className="hue-strip" aria-label="文件类型色">
      {CATEGORY_HUE_ORDER.map(category => (
        <li key={category} data-category={category}>
          <i aria-hidden />
          <span>{CATEGORY_LABEL[category]}</span>
        </li>
      ))}
    </ul>
  )
}
