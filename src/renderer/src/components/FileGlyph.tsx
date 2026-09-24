import { useId } from 'react'
import { AppWindow, Archive, File, FileImage, FileText, Film, Music2, type LucideIcon } from 'lucide-react'
import type { DownloadCategory } from '../lib/types'
import './ui/file-glyph.css'

const GLYPHS: Record<DownloadCategory, LucideIcon> = {
  video: Film,
  audio: Music2,
  document: FileText,
  compressed: Archive,
  application: AppWindow,
  image: FileImage,
  misc: File
}

/**
 * A document icon drawn like a physical sheet: a lit paper body, a folded
 * corner that casts a small shadow, the file's own mark and an extension band
 * in the category hue. It is the one place a file's colour lives on a card.
 * Geometry is authored at 56×70 and scales with `size` (its width in px).
 */
export function FileGlyph({ category, extension, size = 56 }: { category: DownloadCategory; extension?: string; size?: number }) {
  const id = useId().replace(/:/g, '')
  const Icon = GLYPHS[category]
  const label = (extension ?? '').slice(0, 4)
  return (
    <span className="file-glyph" data-category={category} data-labeled={label ? true : undefined} style={{ width: size, height: size * 1.25 }} aria-hidden>
      <svg viewBox="0 0 56 70" className="file-glyph-sheet">
        <defs>
          <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--glyph-paper-top)" />
            <stop offset="1" stopColor="var(--glyph-paper-bottom)" />
          </linearGradient>
          <linearGradient id={`${id}-fold`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--glyph-fold-top)" />
            <stop offset="1" stopColor="var(--glyph-fold-bottom)" />
          </linearGradient>
          <linearGradient id={`${id}-band`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="color-mix(in oklab, var(--category) 88%, white)" />
            <stop offset="1" stopColor="color-mix(in oklab, var(--category) 92%, black)" />
          </linearGradient>
          <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity=".7" />
            <stop offset=".45" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}><path d="M9 1.5h27.5L54.5 19.5V63a5.5 5.5 0 0 1-5.5 5.5H9A5.5 5.5 0 0 1 3.5 63V7A5.5 5.5 0 0 1 9 1.5Z" /></clipPath>
        </defs>
        <path d="M9 1.5h27.5L54.5 19.5V63a5.5 5.5 0 0 1-5.5 5.5H9A5.5 5.5 0 0 1 3.5 63V7A5.5 5.5 0 0 1 9 1.5Z" fill={`url(#${id}-paper)`} />
        <g clipPath={`url(#${id}-clip)`}>
          <rect x="0" y="0" width="56" height="70" fill={`url(#${id}-sheen)`} opacity=".55" />
          {label ? <>
            <rect x="0" y="46" width="56" height="14" fill={`url(#${id}-band)`} />
            <rect x="0" y="46" width="56" height=".75" fill="#fff" opacity=".35" />
          </> : null}
          {/* The fold's shadow falls down-left onto the sheet. */}
          <path d="M36.5 1.5 L54.5 19.5 L50 21 L36 20.5 Z" fill="#000" opacity=".10" />
        </g>
        <path d="M36.5 1.5V14a5.5 5.5 0 0 0 5.5 5.5h12.5Z" fill={`url(#${id}-fold)`} />
        <path d="M9 1.5h27.5L54.5 19.5V63a5.5 5.5 0 0 1-5.5 5.5H9A5.5 5.5 0 0 1 3.5 63V7A5.5 5.5 0 0 1 9 1.5Z" fill="none" stroke="var(--glyph-edge)" strokeWidth=".75" />
        {label ? <text x="29" y="56.4" textAnchor="middle" className="file-glyph-label">{label}</text> : null}
      </svg>
      <Icon className="file-glyph-mark" strokeWidth={1.75} style={{ top: `${label ? 27 : 56}%` }} />
    </span>
  )
}
