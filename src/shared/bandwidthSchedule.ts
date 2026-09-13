export type BandwidthScheduleRule = {
  id: string
  name: string
  enabled: boolean
  /** Local weekdays: Sunday = 0. Overnight periods belong to their start day. */
  days: number[]
  start: string
  end: string
  limitBytesPerSecond: number
}
export type BandwidthScheduleWindow = {
  ruleID: string
  name: string
  start: string
  end: string
  limitBytesPerSecond: number
  windowKey: string
}
export type BandwidthScheduleSnapshot = {
  version: 1
  revision: number
  enabled: boolean
  rules: BandwidthScheduleRule[]
  status: 'off' | 'idle' | 'scheduled' | 'applying' | 'restoring' | 'overridden' | 'temporary' | 'error'
  activeRule: BandwidthScheduleWindow | null
  appliedLimitBytesPerSecond: number | null
  previousLimitBytesPerSecond: number | null
  retryAt: number | null
  error?: string
}
export type BandwidthScheduleReply = { ok: true; state: BandwidthScheduleSnapshot }
  | { ok: false; code: 'invalid' | 'conflict' | 'storage' | 'stopped'; error: string; state: BandwidthScheduleSnapshot }

export const BANDWIDTH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
export const validScheduledBandwidth = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

/** Shared validation keeps persisted data and the review form on the same contract. */
export function validateBandwidthScheduleRules(input: unknown): BandwidthScheduleRule[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error('最多可保存 64 条限速规则。')
  const seen = new Set<string>()
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('限速规则格式无效。')
    const rule = value as Record<string, unknown>
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || seen.has(rule.id)) throw new Error('规则标识无效或重复。')
    seen.add(rule.id)
    if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(rule.name)) throw new Error('请填写不超过 80 个字的规则名称。')
    if (typeof rule.enabled !== 'boolean' || !Array.isArray(rule.days) || !rule.days.length
      || rule.days.length > 7 || rule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(rule.days).size !== rule.days.length) throw new Error('请为规则选择有效的星期。')
    if (typeof rule.start !== 'string' || !TIME.test(rule.start) || typeof rule.end !== 'string' || !TIME.test(rule.end)
      || rule.start === rule.end) throw new Error('请输入有效且不同的开始、结束时间。')
    if (!validScheduledBandwidth(rule.limitBytesPerSecond)) throw new Error('限速必须是非负整数字节数，0 表示不限速。')
    return { id: rule.id, name: rule.name.trim(), enabled: rule.enabled, days: [...rule.days].sort((a, b) => a - b),
      start: rule.start, end: rule.end, limitBytesPerSecond: rule.limitBytesPerSecond }
  })
}

/** Re-evaluate local wall time every time: no 24-hour duration arithmetic across DST.
 * Overlapping rules have an explicit, deterministic priority: first in the list wins. */
export function activeBandwidthScheduleWindow(rules: readonly BandwidthScheduleRule[], now: Date): BandwidthScheduleWindow | null {
  if (!Number.isFinite(now.getTime())) return null
  const day = now.getDay()
  const minute = now.getHours() * 60 + now.getMinutes()
  for (const rule of rules) {
    if (!rule.enabled) continue
    const start = minutes(rule.start)
    const end = minutes(rule.end)
    let previousDay = false
    let active = false
    if (start < end) active = rule.days.includes(day) && minute >= start && minute < end
    else if (minute >= start) active = rule.days.includes(day)
    else if (minute < end) { previousDay = true; active = rule.days.includes((day + 6) % 7) }
    if (!active) continue
    const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (previousDay ? 1 : 0))
    const date = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`
    return { ruleID: rule.id, name: rule.name, start: rule.start, end: rule.end,
      limitBytesPerSecond: rule.limitBytesPerSecond, windowKey: `${rule.id}:${date}:${rule.start}-${rule.end}` }
  }
  return null
}

// bandwidthScheduleStatus: {} -> BandwidthScheduleReply
// bandwidthScheduleSave: { expectedRevision, enabled, rules } -> BandwidthScheduleReply
// Saving explicitly applies the reviewed rules; manual overrides otherwise last until the next window.
