export const TABLE_KEYS = ['filename', 'status', 'size', 'activity', 'progress'] as const
export type TableColumn = typeof TABLE_KEYS[number]
export type TableWidths = Record<TableColumn, number>
export function tableColumnMinimums(width: number): TableWidths {
  const compact = width < 480
  return { filename: compact ? 110 : 180, status: compact ? 0 : 78, size: width < 560 ? 0 : 100, activity: width < 760 ? 0 : 102, progress: width < 320 ? 0 : compact ? 116 : 146 }
}
export function fitTableColumns(available: number, preferred: TableWidths): TableWidths {
  const width = Math.max(0, available)
  const minimum = tableColumnMinimums(width)
  const keys = TABLE_KEYS.filter(key => minimum[key] > 0)
  const result = { filename: 0, status: 0, size: 0, activity: 0, progress: 0 }
  let remaining = width
  let pending = [...keys]
  // Water filling preserves the user's proportions while respecting readable
  // minima. Hidden secondary columns return their space to the main content.
  while (pending.length) {
    const total = pending.reduce((sum, key) => sum + preferred[key], 0)
    const constrained = pending.filter(key => remaining * preferred[key] / total < minimum[key])
    if (!constrained.length) {
      pending.forEach(key => { result[key] = remaining * preferred[key] / total })
      break
    }
    constrained.forEach(key => { result[key] = minimum[key]; remaining -= minimum[key] })
    pending = pending.filter(key => !constrained.includes(key))
    if (remaining < 0) {
      const sum = keys.reduce((n, key) => n + minimum[key], 0)
      keys.forEach(key => { result[key] = width * minimum[key] / sum })
      break
    }
  }
  return result
}
