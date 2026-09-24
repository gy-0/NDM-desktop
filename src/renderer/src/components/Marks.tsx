import { AppWindow, Archive, File, FileImage, FileText, FileVideo, Music2, type LucideIcon } from 'lucide-react'
import type { DownloadCategory } from '../lib/types'

const marks: Record<DownloadCategory, LucideIcon> = {
  video: FileVideo,
  audio: Music2,
  document: FileText,
  compressed: Archive,
  application: AppWindow,
  image: FileImage,
  misc: File
}

/**
 * File identity mark. The tile takes the category hue: a soft wash behind a
 * solid-hue glyph, so a row can be read by colour before its label is read.
 * `data-category` scopes `--category` / `--category-soft` from index.css.
 */
export function TypeMark({ category, size = 'md' }: { category: DownloadCategory; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = marks[category]
  const box =
    size === 'lg' ? 'size-11 rounded-surface' : size === 'sm' ? 'size-9 rounded-surface' : 'size-10 rounded-surface'
  const iconSize = size === 'lg' ? 20 : size === 'sm' ? 16 : 18
  return (
    <span
      data-category={category}
      className={`type-mark grid shrink-0 place-items-center ${box}`}
    >
      <Icon size={iconSize} strokeWidth={1.6} />
    </span>
  )
}
