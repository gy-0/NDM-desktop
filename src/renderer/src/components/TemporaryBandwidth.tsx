import { Clock3, Gauge, LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import type { TemporaryBandwidthDuration, TemporaryBandwidthSnapshot } from '../../../shared/temporaryBandwidth'
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
  const errorId = useId()
  const active = snapshot.status !== 'inactive'
  const issue = error || snapshot.error
  return <section className="temporary-bandwidth" aria-label="临时文件限速" data-temporary-bandwidth>
    {active ? <div className="temporary-bandwidth-status">
      <Clock3 size={14} aria-hidden />
      <div className="min-w-0">
        <p className="text-label font-medium text-paper">{snapshot.status === 'restoring' ? '正在恢复原限速' : snapshot.status === 'checking' ? '正在确认临时限速' : `临时文件限速 ${rateLabel(snapshot.limitBytesPerSecond)}`}</p>
        <p className="mt-1 text-meta text-mist">每项上限 · {deadlineLabel(snapshot.expiresAt)} 恢复{rateLabel(snapshot.previousLimitBytesPerSecond)}</p>
      </div>
    </div> : null}
    {!active && !editing ? <button type="button" className="temporary-bandwidth-entry text-label" onClick={() => setEditing(true)}><Gauge size={14} aria-hidden />临时文件限速…</button> : null}
    {active && !editing ? <div className="temporary-bandwidth-actions text-label">
      <button type="button" disabled={busy} onClick={() => { setLimit(snapshot.limitBytesPerSecond || 5 * 1048576); setEditing(true) }}>修改</button>
      <button type="button" disabled={busy} aria-describedby={issue ? errorId : undefined} onClick={() => void onRestore()}>{busy ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : null}现在恢复</button>
    </div> : null}
    {editing ? <form onSubmit={event => { event.preventDefault(); void onApply(limit, minutes).then(ok => { if (ok) setEditing(false) }) }}>
      <p className="mb-3 text-label font-medium text-paper">临时文件限速</p>
      <div className="temporary-bandwidth-fields">
        <label><span>每项速度</span><select aria-label="临时下载速度" disabled={busy} value={limit} onChange={event => setLimit(Number(event.target.value))}>
          {![1, 5, 10].some(rate => rate * 1048576 === limit) ? <option value={limit}>{rateLabel(limit)}</option> : null}
          {[1, 5, 10].map(rate => <option key={rate} value={rate * 1048576}>{rate} MB/s</option>)}
        </select></label>
        <label><span>时长</span><select aria-label="临时限速时长" disabled={busy} value={minutes} onChange={event => setMinutes(Number(event.target.value) as TemporaryBandwidthDuration)}>
          {[15, 30, 60].map(duration => <option key={duration} value={duration}>{duration} 分钟</option>)}
        </select></label>
      </div>
      <p className="mt-2 text-meta leading-relaxed text-mist">普通文件的默认限速，到时自动恢复。</p>
      <div className="temporary-bandwidth-actions text-label"><button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button type="submit" className="temporary-bandwidth-apply" disabled={busy} aria-describedby={issue ? errorId : undefined}>{busy ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : null}{busy ? '正在设置…' : '应用限速'}</button></div>
    </form> : null}
    {issue ? <p id={errorId} role="status" className="mt-2 text-meta leading-relaxed text-clay">{issue}</p> : null}
  </section>
}
