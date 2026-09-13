import { ArrowUpRight, Clock3, Gauge } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { TemporaryBandwidthDuration, TemporaryBandwidthSnapshot } from '../../../shared/temporaryBandwidth'
import { AnimatedHeight } from './ui/AnimatedHeight'
import { TransferActionIcon } from './ui/TransferActionIcon'
import './ui/temporary-bandwidth.css'

const rateLabel = (rate: number | null): string => rate ? `${Math.round(rate / 1048576 * 100) / 100} MB/s` : '不限速'
const deadlineLabel = (expiresAt: number | null): string => expiresAt ? new Date(expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''

export function temporaryBandwidthLabel(snapshot: TemporaryBandwidthSnapshot): string | undefined {
  return snapshot.status === 'inactive' ? undefined : `临时文件限速 ${rateLabel(snapshot.limitBytesPerSecond)}，${deadlineLabel(snapshot.expiresAt)} 恢复`
}

export function TemporaryBandwidth({ snapshot, busy, error, onApply, onRestore }: {
  snapshot: TemporaryBandwidthSnapshot
  busy: boolean
  error?: string
  onApply: (limit: number, minutes: TemporaryBandwidthDuration) => Promise<boolean>
  onRestore: () => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [limit, setLimit] = useState(5 * 1048576)
  const [minutes, setMinutes] = useState<TemporaryBandwidthDuration>(30)
  const entryRef = useRef<HTMLButtonElement>(null)
  const speedRef = useRef<HTMLSelectElement>(null)
  const restoreFocus = useRef(false)
  const errorId = useId()
  const editorId = useId()
  const active = snapshot.status !== 'inactive'
  const issue = error || snapshot.error
  const finishEditing = () => { restoreFocus.current = true; setEditing(false) }

  useLayoutEffect(() => {
    if (editing) speedRef.current?.focus({ preventScroll: true })
    else if (restoreFocus.current) {
      entryRef.current?.focus({ preventScroll: true })
      restoreFocus.current = false
    }
  }, [editing])

  return <section className="temporary-bandwidth" aria-label="临时文件限速" data-temporary-bandwidth data-editing={editing || undefined} data-active={active || undefined}>
    <div className="temporary-bandwidth-heading">
      <span className="temporary-bandwidth-heading-icon">{active ? <Clock3 size={15} aria-hidden /> : <Gauge size={15} aria-hidden />}</span>
      <div className="min-w-0">
        <p className="text-label font-medium text-paper">{active ? snapshot.status === 'restoring' ? '正在恢复原限速' : snapshot.status === 'checking' ? '正在确认临时限速' : `临时文件限速 ${rateLabel(snapshot.limitBytesPerSecond)}` : '临时文件限速'}</p>
        {active ? <p className="mt-1 text-meta text-mist">每项上限 · {deadlineLabel(snapshot.expiresAt)} 恢复{rateLabel(snapshot.previousLimitBytesPerSecond)}</p> : null}
      </div>
    </div>
    <AnimatedHeight className="temporary-bandwidth-reveal" contentClassName="temporary-bandwidth-content">
      {editing ? <form id={editorId} onSubmit={event => { event.preventDefault(); void onApply(limit, minutes).then(ok => { if (ok) finishEditing() }) }}>
        <div className="temporary-bandwidth-fields">
          <label><span><Gauge size={12} aria-hidden />每项速度</span><select ref={speedRef} aria-label="临时下载速度" disabled={busy} value={limit} onChange={event => setLimit(Number(event.target.value))}>
            {![1, 5, 10].some(rate => rate * 1048576 === limit) ? <option value={limit}>{rateLabel(limit)}</option> : null}
            {[1, 5, 10].map(rate => <option key={rate} value={rate * 1048576}>{rate} MB/s</option>)}
          </select></label>
          <label><span><Clock3 size={12} aria-hidden />持续时间</span><select aria-label="临时限速时长" disabled={busy} value={minutes} onChange={event => setMinutes(Number(event.target.value) as TemporaryBandwidthDuration)}>
            {[15, 30, 60].map(duration => <option key={duration} value={duration}>{duration} 分钟</option>)}
          </select></label>
        </div>
        <p className="temporary-bandwidth-note text-meta">普通文件的默认限速，到时自动恢复。</p>
        <div className="temporary-bandwidth-actions text-label"><button type="button" disabled={busy} onClick={finishEditing}>取消</button><button type="submit" className="temporary-bandwidth-apply" disabled={busy} aria-describedby={issue ? errorId : undefined}>{busy ? <TransferActionIcon state="pending" size={12} /> : null}{busy ? '正在设置…' : '应用限速'}</button></div>
      </form> : active ? <>
        <div className="temporary-bandwidth-readout" aria-hidden><span><span>每项速度</span><strong>{rateLabel(snapshot.limitBytesPerSecond)}</strong></span><span><span>恢复时间</span><strong>{deadlineLabel(snapshot.expiresAt) || '确认中'}</strong></span></div>
        <div className="temporary-bandwidth-actions text-label">
          <button ref={entryRef} type="button" disabled={busy} aria-expanded={false} aria-controls={editorId} onClick={() => { setLimit(snapshot.limitBytesPerSecond || 5 * 1048576); setEditing(true) }}>修改</button>
          <button type="button" disabled={busy} aria-describedby={issue ? errorId : undefined} onClick={() => void onRestore()}>{busy ? <TransferActionIcon state="pending" size={12} /> : null}现在恢复</button>
        </div>
      </> : <button ref={entryRef} type="button" className="temporary-bandwidth-entry" aria-label="临时文件限速…" aria-expanded={false} aria-controls={editorId} onClick={() => setEditing(true)}>
        <span className="temporary-bandwidth-readout"><span><span>每项速度</span><strong>设置上限</strong></span><span><span>持续时间</span><strong>到时恢复</strong></span></span>
        <span className="temporary-bandwidth-entry-action text-meta">临时文件限速…<ArrowUpRight size={12} aria-hidden /></span>
      </button>}
    </AnimatedHeight>
    {issue ? <p id={errorId} role="status" className="mt-2 text-meta leading-relaxed text-clay">{issue}</p> : null}
  </section>
}
