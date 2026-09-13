import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CalendarClock, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import {
  activeBandwidthScheduleWindow, BANDWIDTH_WEEKDAYS, validateBandwidthScheduleRules,
  type BandwidthScheduleReply, type BandwidthScheduleRule, type BandwidthScheduleSnapshot
} from '../../../shared/bandwidthSchedule'
import { formatBytes } from '../lib/format'

const CONTROL = 'inline-flex h-control items-center justify-center gap-1.5 rounded-control border border-line px-2.5 text-label transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD = 'h-control w-full rounded-control border border-line bg-raised px-2 text-label text-paper outline-none focus:border-line-strong disabled:opacity-50'
const limitLabel = (limit: number): string => limit === 0 ? '不限速' : `${formatBytes(limit)}/s`

async function request(op: string, extra: Record<string, unknown> = {}): Promise<BandwidthScheduleSnapshot> {
  const reply = await window.ndm?.request(op, extra) as BandwidthScheduleReply | undefined
  if (!reply || typeof reply.ok !== 'boolean') throw new Error('周期限速服务暂不可用，请稍后重试。')
  if (!reply.ok) throw new Error(reply.error)
  return reply.state
}

export function BandwidthSchedulePanel() {
  const id = useId()
  const mounted = useRef(true)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const revision = useRef(0)
  const [state, setState] = useState<BandwidthScheduleSnapshot | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [rules, setRules] = useState<BandwidthScheduleRule[]>([])
  const [draftRevision, setDraftRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)

  const hydrate = (value: BandwidthScheduleSnapshot): void => {
    setEnabled(value.enabled)
    setRules(value.rules)
    setDraftRevision(value.revision)
    dirtyRef.current = false
    setDirty(false)
  }
  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (busyRef.current) { timer = setTimeout(() => { void poll() }, 2000); return }
      const current = revision.current
      try {
        const value = await request('bandwidthScheduleStatus')
        if (stopped || current !== revision.current) return
        setState(value)
        setNow(Date.now())
        if (!dirtyRef.current) hydrate(value)
      } catch (reason) {
        if (!stopped && current === revision.current) setError(reason instanceof Error ? reason.message : '暂时无法读取周期限速。')
      } finally {
        if (!stopped) { setLoading(false); timer = setTimeout(() => { void poll() }, 2000) }
      }
    }
    void poll()
    return () => { stopped = true; mounted.current = false; clearTimeout(timer) }
  }, [])

  const edit = (): void => { dirtyRef.current = true; setDirty(true); setNotice(null); setError(null) }
  const update = (ruleID: string, patch: Partial<BandwidthScheduleRule>): void => {
    edit()
    setRules(current => current.map(rule => rule.id === ruleID ? { ...rule, ...patch } : rule))
  }
  const move = (index: number, offset: number): void => {
    edit()
    setRules(current => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(index + offset, 0, item)
      return next
    })
  }
  const save = async (): Promise<void> => {
    if (loading || busyRef.current) return
    let valid: BandwidthScheduleRule[]
    try {
      valid = validateBandwidthScheduleRules(rules)
      if (enabled && !valid.some(rule => rule.enabled)) throw new Error('请先添加并启用至少一条规则。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请检查规则。'); return }
    const current = ++revision.current
    busyRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const value = await request('bandwidthScheduleSave', { expectedRevision: draftRevision, enabled, rules: valid })
      if (!mounted.current || current !== revision.current) return
      setState(value)
      hydrate(value)
      setNotice(value.status === 'error' ? '规则已保存，限速尚未确认，将自动重试。' : '周期限速规则已保存。')
    } catch (reason) {
      if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : '规则未能保存，请重试。')
    } finally {
      if (current === revision.current) { busyRef.current = false; if (mounted.current) setBusy(false) }
    }
  }
  const reload = async (): Promise<void> => {
    if (busyRef.current) return
    const current = ++revision.current
    busyRef.current = true
    setBusy(true)
    try {
      const value = await request('bandwidthScheduleStatus')
      if (!mounted.current || current !== revision.current) return
      setState(value)
      hydrate(value)
      setError(null)
      setNotice(null)
    } catch (reason) {
      if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : '暂时无法读取规则。')
    } finally {
      if (current === revision.current) { busyRef.current = false; if (mounted.current) setBusy(false) }
    }
  }

  const preview = enabled ? activeBandwidthScheduleWindow(rules, new Date(now)) : null
  const disabled = loading || busy
  const conflict = dirty && state !== null && state.revision !== draftRevision
  return <section className="space-y-3" aria-label="周期限速" data-bandwidth-schedule-panel>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-body font-medium text-paper"><CalendarClock size={14} />周期限速</div>
      <label className="flex items-center gap-2 text-label text-mist"><input type="checkbox" aria-label="启用周期限速" checked={enabled} disabled={disabled}
        onChange={event => { edit(); setEnabled(event.target.checked) }} />启用</label>
    </div>
    <p className="text-label leading-relaxed text-mist">按电脑本地时间运行，重叠时靠前的规则优先。跨午夜的时段归开始日；0 表示不限速。</p>
    <div className="space-y-3">
      {rules.map((rule, index) => <fieldset key={rule.id} disabled={disabled} className="space-y-2 rounded-control border border-line p-3">
        <legend className="px-1 text-label text-mist">规则 {index + 1}{index === 0 ? ' · 最高优先' : ''}</legend>
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={rule.enabled} aria-label={`启用规则 ${index + 1}`} onChange={event => update(rule.id, { enabled: event.target.checked })} />
          <input className={FIELD} aria-label={`规则 ${index + 1} 名称`} value={rule.name} maxLength={80} onChange={event => update(rule.id, { name: event.target.value })} />
          <button type="button" className="text-mist hover:text-paper disabled:opacity-30" aria-label={`上移规则 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
          <button type="button" className="text-mist hover:text-paper disabled:opacity-30" aria-label={`下移规则 ${index + 1}`} disabled={disabled || index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
          <button type="button" className="text-mist hover:text-clay" aria-label={`删除规则 ${index + 1}`} onClick={() => { edit(); setRules(current => current.filter(item => item.id !== rule.id)) }}><Trash2 size={13} /></button>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label={`规则 ${index + 1} 的星期`}>
          {[1, 2, 3, 4, 5, 6, 0].map(day => <button type="button" key={day} aria-label={BANDWIDTH_WEEKDAYS[day]} aria-pressed={rule.days.includes(day)}
            className={`rounded-control border px-2 py-1 text-label ${rule.days.includes(day) ? 'border-line-strong bg-raised text-paper' : 'border-line text-mist'}`}
            onClick={() => update(rule.id, { days: rule.days.includes(day) ? rule.days.filter(value => value !== day) : [...rule.days, day] })}>{BANDWIDTH_WEEKDAYS[day].slice(1)}</button>)}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1 text-label text-mist">开始<input type="time" className={FIELD} value={rule.start} onChange={event => update(rule.id, { start: event.target.value })} /></label>
          <label className="space-y-1 text-label text-mist">结束<input type="time" className={FIELD} value={rule.end} onChange={event => update(rule.id, { end: event.target.value })} /></label>
          <label className="space-y-1 text-label text-mist">KiB/s<input type="number" min={0} step="any" className={FIELD}
            value={Number.isFinite(rule.limitBytesPerSecond) ? rule.limitBytesPerSecond / 1024 : ''}
            onChange={event => update(rule.id, { limitBytesPerSecond: Number.isFinite(event.target.valueAsNumber) ? Math.round(event.target.valueAsNumber * 1024) : NaN })} /></label>
        </div>
        {rule.start > rule.end && <p className="text-[10px] text-mist">持续至次日 {rule.end}。</p>}
      </fieldset>)}
    </div>
    <button type="button" className={`${CONTROL} text-mist`} disabled={disabled || rules.length >= 64} onClick={() => {
      edit()
      setRules(current => [...current, { id: crypto.randomUUID(), name: `规则 ${current.length + 1}`, enabled: true,
        days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', limitBytesPerSecond: 1_048_576 }])
    }}><Plus size={12} />添加规则</button>
    <p className="rounded-control bg-raised px-3 py-2 text-label text-mist" id={`${id}-preview`}>
      {preview ? `按当前编辑：${preview.name} · ${limitLabel(preview.limitBytesPerSecond)}（${preview.start}–${preview.end}）` : enabled ? '按当前编辑：此刻不在任何限速时段。' : '周期限速关闭。'}
    </p>
    <div aria-live="polite" className="space-y-1.5 text-label leading-relaxed text-mist">
      {state?.status === 'scheduled' && state.appliedLimitBytesPerSecond !== null && <p>已确认生效：{state.activeRule?.name} · {limitLabel(state.appliedLimitBytesPerSecond)}</p>}
      {state?.status === 'temporary' && <p>临时限速优先；结束后会按届时时间重新检查规则。</p>}
      {state?.status === 'overridden' && <p>本时段采用你的手动设置，下一时段恢复规则。保存并应用可立即重新接管。</p>}
      {state?.status === 'restoring' && <p>正在确认恢复规则生效前的限速…</p>}
      {state?.error && <p className="text-clay">{state.error}{state.retryAt ? ' 将自动重试。' : ''}</p>}
      {conflict && <p className="text-clay">规则已在其他窗口更新，请重新读取后再保存。</p>}
      {notice && <p>{notice}</p>}
      {error && <p role="alert" className="text-clay">{error}</p>}
    </div>
    <p className="text-[10px] leading-relaxed text-mist">手动限速优先于当前时段；临时限速到期前，规则不会改写它。连接数保持原设置。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`${CONTROL} text-paper`} disabled={disabled || conflict} aria-describedby={`${id}-preview`} onClick={() => { void save() }}>
        {disabled && <LoaderCircle size={12} className="animate-spin" />}{loading ? '读取规则…' : busy ? '正在保存…' : enabled ? '保存并应用规则' : '保存并关闭规则'}
      </button>
      {dirty && <button type="button" className={`${CONTROL} text-mist`} disabled={busy} onClick={() => { void reload() }}>放弃编辑并重新读取</button>}
    </div>
  </section>
}
