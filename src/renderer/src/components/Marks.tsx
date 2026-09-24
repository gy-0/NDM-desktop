import type { DownloadCategory } from '../lib/types'
import { FileGlyph } from './FileGlyph'

const GLYPH_WIDTH = { sm: 28, md: 30, lg: 34 } as const

/**
 * File identity mark: the same lit document glyph the gallery uses, sized for
 * rows, the hero and previews. `data-category` scopes `--category` from
 * index.css, so the file's hue lives on the glyph alone.
 */
export function TypeMark({ category, size = 'md', extension }: { category: DownloadCategory; size?: 'sm' | 'md' | 'lg'; extension?: string }) {
  const box = size === 'lg' ? 'size-11' : size === 'sm' ? 'size-9' : 'size-10'
  return (
    <span data-category={category} className={`type-mark grid shrink-0 place-items-center ${box}`}>
      <FileGlyph category={category} extension={extension} size={GLYPH_WIDTH[size]} />
    </span>
  )
}
