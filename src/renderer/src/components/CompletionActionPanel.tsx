import { useEffect, useId, useRef, useState } from 'react'
import { Check, Clock3, LoaderCircle, Power, Square } from 'lucide-react'
import {
  COMPLETION_ACTIONS, type CompletionAction, type CompletionActionReply, type CompletionActionState
} from '../../../shared/completionAction'

const CONTROL = 'inline-flex h-control items-center justify-center gap-1.5 rounded-control border border-line px-2.5 text-label transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20 disabled:cursor-not-allowed disabled:opacity-50'
const DISABLED_STATE: CompletionActionState = { oneShot: true, phase: 'off', trackedTaskIDs: [], remainingTaskCount: 0 }

async function request(op: string, extra: Record<string, unknown> = {}): Promise<CompletionActionState> {
  const reply = await window.ndm?.request(op, extra) as CompletionActionReply | undefined
  if (!reply || typeof reply.ok !== 'boolean') throw new Error('暂时无法读取完成后操作，请稍后重试。')
  if (!reply.ok) throw new Error(reply.error)
  return reply.state
}

/** Explicitly confirmed and process-local: reopening NDM never arms a power action. */
export function CompletionActionPanel() {
  const choiceID = useId()
  const mounted = useRef(true)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const [state, setState] = useState<CompletionActionState>(DISABLED_STATE)
  const [action, setAction] = useState<CompletionAction | ''>('')
  const [delaySeconds, setDelaySeconds] = useState(60)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const waiting = state.phase === 'armed' || state.phase === 'countdown'
  const executing = state.phase === 'executing'
  const enabled = waiting || executing

  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (busyRef.current) {
        timer = setTimeout(() => { void poll() }, 1000)
        return
      }
      const current = revision.current
      try {
        const result = await request('completionActionStatus')
        if (stopped || current !== revision.current) return
        setState(result)
        setError(null)
        if (result.action && ['armed', 'countdown', 'executing'].includes(result.phase)) {
          setAction(result.action)
          setDelaySeconds(result.delaySeconds ?? 60)
        }
      } catch (reason) {
        if (!stopped && current === revision.current) setError(reason instanceof Error ? reason.message : '暂时无法确认完成后操作。')
      } finally {
        if (!stopped) {
          setLoading(false)
          timer = setTimeout(() => { void poll() }, 1000)
        }
      }
    }
    void poll()
    return () => { stopped = true; mounted.current = false; clearTimeout(timer) }
  }, [])

  useEffect(() => {
    if (state.phase !== 'countdown') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [state.phase, state.countdownEndsAt])

  const arm = async (): Promise<void> => {
    if (!action || loading || busyRef.current || enabled) return
    const current = ++revision.current
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request('completionActionArm', { action, delaySeconds })
      if (mounted.current && current === revision.current) setState(result)
    } catch (reason) {
      if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : '未能启用完成后操作。')
    } finally {
      if (current === revision.current) {
        busyRef.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    if (busyRef.current || executing) return
    const current = ++revision.current
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request('completionActionCancel')
      if (mounted.current && current === revision.current) setState(result)
    } catch (reason) {
      if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : '暂时无法取消，请重试。')
    } finally {
      if (current === revision.current) {
        busyRef.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }

  const selectedLabel = action ? COMPLETION_ACTIONS[action].label : ''
  const activeLabel = state.action ? COMPLETION_ACTIONS[state.action].label : ''
  const secondsLeft = Math.max(0, Math.ceil(((state.countdownEndsAt ?? now) - now) / 1000))

  return <section className="space-y-3" aria-label="下载完成后操作" data-completion-action-panel>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-body font-medium text-paper"><Power size={14} />下载完成后</div>
      <span className="text-label text-mist">{enabled ? '本次已启用' : '默认关闭'}</span>
    </div>
    <p className="text-label leading-relaxed text-mist">仅执行一次。关闭或重新打开 NDM 后，需要重新启用。</p>
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <div>
        <label htmlFor={choiceID} className="mb-1.5 block text-label text-mist">完成后的操作</label>
        <select id={choiceID} value={action} disabled={loading || busy || enabled}
          onChange={event => setAction(event.target.value as CompletionAction | '')}
          className="h-control w-full rounded-control border border-line bg-raised px-2 text-label text-paper outline-none focus:border-line-strong disabled:opacity-50">
          <option value="">请选择操作</option>
          {(Object.keys(COMPLETION_ACTIONS) as CompletionAction[]).map(value => <option value={value} key={value}>{COMPLETION_ACTIONS[value].label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${choiceID}-delay`} className="mb-1.5 block text-label text-mist">倒计时</label>
        <select id={`${choiceID}-delay`} value={delaySeconds} disabled={loading || busy || enabled}
          onChange={event => setDelaySeconds(Number(event.target.value))}
          className="h-control rounded-control border border-line bg-raised px-2 text-label text-paper outline-none focus:border-line-strong disabled:opacity-50">
          {[30, 60, 90, 120, 180, 240, 300].map(value => <option value={value} key={value}>{value} 秒</option>)}
        </select>
      </div>
    </div>
    {!enabled && action && <p className="rounded-control bg-raised px-3 py-2 text-label leading-relaxed text-fog">
      本次等待中的下载及后续新增下载全部完成后，倒计时 {delaySeconds} 秒，再{selectedLabel}。
      {action === 'shutdown' && '请先保存其他应用中的工作。'}
    </p>}
    <div aria-live="polite">
      {state.phase === 'armed' && <div className="text-label leading-relaxed text-mist">
        <p>正在等待 {state.remainingTaskCount} / {state.trackedTaskIDs.length} 项下载完成，再{activeLabel}。</p>
        {state.reason === 'taskMissing' ? <p className="mt-1 text-clay">有等待中的任务已被移除，操作不会执行。请取消后重新设置。</p>
          : state.reason === 'snapshotUnavailable' ? <p className="mt-1 text-clay">无法确认下载状态，倒计时已停止。</p>
            : <p className="mt-1">暂停、失败、排队或录制中的任务会继续等待。</p>}
      </div>}
      {state.phase === 'countdown' && <div className="rounded-control border border-line-strong bg-raised px-3 py-2 text-body text-paper">
        <p className="flex items-center gap-2"><Clock3 size={14} /><span className="tabular-nums">{secondsLeft} 秒</span>后{activeLabel}</p>
        <p className="mt-1.5 text-label text-mist">新增或恢复下载会重新等待；你也可以随时取消。</p>
      </div>}
      {executing && <p className="flex items-center gap-2 text-label text-mist"><LoaderCircle size={13} className="animate-spin" />正在{activeLabel}…</p>}
      {state.phase === 'completed' && state.action && <p className="flex items-center gap-1.5 text-label text-sage"><Check size={13} />{COMPLETION_ACTIONS[state.action].result}，本次设置已用完。</p>}
      {state.error && <p className="mt-1.5 text-label text-clay">{state.error}</p>}
      {error && <p role="alert" className="mt-1.5 text-label text-clay">{error}</p>}
    </div>
    {waiting ? <button type="button" className={`${CONTROL} text-paper`} disabled={busy} onClick={() => { void cancel() }}>
      <Square size={12} />{busy ? '正在取消…' : '取消本次操作'}
    </button> : !executing && <button type="button" className={`${CONTROL} ${action === 'shutdown' ? 'text-clay' : 'text-paper'}`}
      disabled={loading || busy || !action} onClick={() => { void arm() }}>
      {(loading || busy) && <LoaderCircle size={12} className="animate-spin" />}
      {loading ? '读取状态…' : busy ? '正在启用…' : action ? `确认启用：${selectedLabel}` : '选择操作后启用'}
    </button>}
  </section>
}
