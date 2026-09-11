export interface SearchableCommand {
  id: string
  label: string
  detail?: string
  keywords?: string[]
  disabled?: boolean
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim()
}

function matchesChineseLabel(label: string, term: string): boolean {
  if (!/^\p{Script=Han}{2,}$/u.test(term)) return false
  let from = 0
  for (const character of term) {
    const index = label.indexOf(character, from)
    if (index < 0) return false
    from = index + character.length
  }
  return true
}

/** Match every word against the command's own text, preserving the caller's order. */
export function filterCommands<T extends SearchableCommand>(items: T[], query: string): T[] {
  const terms = normalized(query).split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return items
  return items.filter((item) => {
    const searchable = [item.label, item.detail ?? '', ...(item.keywords ?? [])].map(normalized).join(' ')
    // Chinese has no word delimiters: “复制链接” should also find “复制下载链接”.
    return terms.every((term) => searchable.includes(term) || matchesChineseLabel(normalized(item.label), term))
  })
}

/** Keyboard navigation skips unavailable actions and wraps within the visible results. */
export function nextCommandId<T extends SearchableCommand>(items: T[], currentId: string | null, direction: 1 | -1): string | null {
  const available = items.filter((item) => !item.disabled)
  if (available.length === 0) return null
  const index = available.findIndex((item) => item.id === currentId)
  if (index < 0) return available[direction === 1 ? 0 : available.length - 1].id
  return available[(index + direction + available.length) % available.length].id
}
