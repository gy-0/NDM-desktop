import type { MediaFormat } from './types'

/** Keep the current choice visible even when the complete quality list is folded. */
export function visibleMediaFormats(formats: MediaFormat[], selectedID: string | null, expanded: boolean): MediaFormat[] {
  if (expanded || formats.length <= 6) return formats
  const selected = formats.findIndex(format => format.id === selectedID)
  return selected >= 6 ? [...formats.slice(0, 5), formats[selected]] : formats.slice(0, 6)
}
