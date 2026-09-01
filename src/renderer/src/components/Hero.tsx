import { ChevronDown, Gauge, Pause, Play, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatByteProgress, formatEta, formatSpeed, fractionOf, isDistinctTitle, remainingSeconds } from '../lib/format'
import { PHASE_LABEL, type Task } from '../lib/types'
import { useProgressStyle } from '../lib/presentationPrefs'
import { setTaskBandwidth, setTaskConnections } from '../lib/store'
import { CONNECTION_OPTIONS } from '../lib/platform'
import { cue } from '../lib/sound'
import { Connections } from './Connections'
import { LoadingMark } from './LoadingMark'
import { TypeMark } from './Marks'
import { TransferField } from '../effects/metalforge/ProductMotion'

export function Hero({
  task,
  actionBusy,
  actionErrorId,
  onToggle
}: {
  task: Task
  actionBusy: boolean
  actionErrorId?: string
  onToggle: (task: Task) => void
}) {
  const speed = formatSpeed(task.bytesPerSecond)
  const fraction = fractionOf(task)
  const eta = formatEta(remainingSeconds(task))
  const progressStyle = useProgressStyle()
  const activeSegments = task.segments.length
  const [tuningOpen, setTuningOpen] = useState(false)
  const [savingTuning, setSavingTuning] = useState<'connections' | 'bandwidth' | null>(null)
  const [tuningError, setTuningError] = useState('')

  useEffect(() => {
    setTuningOpen(false)
    setSavingTuning(null)
    setTuningError('')
  }, [task.id])

  const applyConnections = async (connections: number): Promise<void> => {
    if (savingTuning) return
    setSavingTuning('connections')
    setTuningError('')
    try {
      await setTaskConnections(task.id, connections)
      cue('toggle')
    } catch {
      setTuningError('连接数没有更新，请检查下载引擎。')
    } finally {
      setSavingTuning(null)
    }
  }

  const applyBandwidth = async (bandwidthLimit: number): Promise<void> => {
    if (savingTuning) return
    setSavingTuning('bandwidth')
    setTuningError('')
    try {
      await setTaskBandwidth(task.id, bandwidthLimit)
      cue('toggle')
    } catch {
      setTuningError('限速没有更新，请检查下载引擎。')
    } finally {
      setSavingTuning(null)
    }
  }

  const taskLimit = task.bandwidthLimit ?? 0
  const effectiveLimit = task.effectiveBandwidthLimit ?? taskLimit
  const formatLimit = (value: number): string => `${Math.round((value / 1_048_576) * 10) / 10} MB/s`
  const taskLimitLabel = taskLimit > 0
    ? `任务 ${formatLimit(taskLimit)}`
    : effectiveLimit > 0
      ? `全局 ${formatLimit(effectiveLimit)}`
      : '不限速'

  return (
    <section className="relative overflow-hidden border-b border-line px-6 py-4">
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
      <TransferField progressFraction={fraction} identity={task.id} />
      <div className="relative flex items-center gap-3.5">
        <TypeMark category={task.category} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 text-[10.5px] tracking-[0.06em] text-mist">
            {task.phase === 'preparing' ? (
              <LoadingMark label={PHASE_LABEL.preparing} />
            ) : (
              <span className={task.phase && task.phase !== 'transferring' ? 'text-copper' : ''}>
                {task.phase ? PHASE_LABEL[task.phase] : '正在下载'}
              </span>
            )}
          </div>
          <h1 className="mt-1.5 truncate font-serif text-[23px] leading-[1.12] tracking-[-0.025em]" title={task.filename || task.title}>
            {task.filename || task.title}
          </h1>
          <p className="mt-1 truncate text-[11px] text-mist" title={isDistinctTitle(task.title, task.filename) ? task.title : task.source}>
            {isDistinctTitle(task.title, task.filename) ? task.title : task.source}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="font-mono text-[24px] leading-none tabular-nums tracking-[-0.04em]">{speed.value}</span>
            <span className="text-[11px] text-mist">{speed.unit}</span>
          </div>
          <div className="mt-1 text-[11px] text-fog">剩余 {eta}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-expanded={tuningOpen}
            onClick={() => {
              setTuningOpen((open) => !open)
              setTuningError('')
              cue('tick')
            }}
            className="app-no-drag flex h-9 items-center gap-1.5 rounded-full bg-raised px-3 text-[11.5px] text-fog shadow-[0_0_0_1px_var(--line)] transition-[color,background-color] duration-120 hover:bg-raised/80 hover:text-paper"
            title="实时调节连接数与限速"
          >
            <SlidersHorizontal size={13} strokeWidth={1.7} />
            <span className="font-mono tabular-nums">{task.connections}</span>
            <span className="text-mist">连接</span>
            <span className="text-mist/60">·</span>
            <span className="max-w-24 truncate text-mist">{taskLimitLabel}</span>
            <ChevronDown size={11} className={`transition-transform duration-150 ${tuningOpen ? 'rotate-180' : ''}`} />
          </button>
          <button
            type="button"
            disabled={actionBusy}
            aria-describedby={actionErrorId}
            onClick={() => onToggle(task)}
            className="app-no-drag grid size-9 shrink-0 place-items-center rounded-full bg-raised text-fog shadow-[0_0_0_1px_var(--line-strong)] transition-[scale,color,background-color] duration-150 hover:text-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
            data-cuelume-press
            aria-label={task.status === 'downloading' ? '暂停下载' : '继续下载'}
            title={task.status === 'downloading' ? '暂停' : '继续'}
          >
            {task.status === 'downloading' ? <Pause size={15} strokeWidth={1.8} /> : <Play size={15} strokeWidth={1.8} className="translate-x-px" />}
          </button>
        </div>
      </div>

      <div className="relative mt-3">
        <div className="flex items-center justify-between text-[10.5px] text-mist">
          <span className="tabular-nums">{formatByteProgress(task.completedBytes, task.fileSize)}</span>
          <span className="tabular-nums text-fog">{Math.round(fraction * 100)}%</span>
        </div>
        <div className="mt-1.5">
          <Connections segments={task.segments} fraction={fraction} fileSize={task.fileSize} style={progressStyle} />
        </div>
        {progressStyle === 'segmented' && activeSegments > 1 ? (
          <div className="mt-1.5 text-right text-[10.5px] tracking-[0.04em] text-mist">
            {activeSegments} 个分段
          </div>
        ) : null}
      </div>

      {tuningOpen ? (
        <div className="relative mt-3 grid grid-cols-[1fr_1fr] gap-4 border-t border-line/70 pt-3">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-fog">
                <SlidersHorizontal size={12} />实时连接数
              </span>
              <span className="text-[10.5px] text-mist">无需暂停</span>
            </div>
            <div
              className="grid gap-1 rounded-[8px] bg-panel/55 p-1 shadow-[inset_0_0_0_1px_var(--line)]"
              style={{ gridTemplateColumns: `repeat(${CONNECTION_OPTIONS.length + 1}, minmax(0, 1fr))` }}
            >
              {[1, ...CONNECTION_OPTIONS].map((connections) => (
                <button
                  key={connections}
                  type="button"
                  disabled={Boolean(savingTuning)}
                  onClick={() => void applyConnections(connections)}
                  className={`h-7 rounded-[5px] font-mono text-[11px] tabular-nums transition-colors disabled:opacity-55 ${
                    task.connections === connections
                      ? 'bg-raised font-medium text-paper shadow-[0_0_0_1px_var(--line-strong)]'
                      : 'text-mist hover:bg-raised/55 hover:text-paper'
                  }`}
                >
                  {connections}
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-fog">
                <Gauge size={12} />此任务限速
              </span>
              <span className="font-mono text-[10.5px] tabular-nums text-mist">{taskLimitLabel}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 rounded-[8px] bg-panel/55 p-1 shadow-[inset_0_0_0_1px_var(--line)]">
              {[
                { label: '跟随', value: 0 },
                { label: '1', value: 1_048_576 },
                { label: '5', value: 5_242_880 },
                { label: '10', value: 10_485_760 }
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={Boolean(savingTuning)}
                  onClick={() => void applyBandwidth(option.value)}
                  className={`h-7 rounded-[5px] text-[11px] transition-colors disabled:opacity-55 ${
                    taskLimit === option.value
                      ? 'bg-raised font-medium text-paper shadow-[0_0_0_1px_var(--line-strong)]'
                      : 'text-mist hover:bg-raised/55 hover:text-paper'
                  }`}
                >
                  {option.label}{option.value > 0 ? <span className="ml-0.5 text-[8.5px] text-mist">MB/s</span> : null}
                </button>
              ))}
            </div>
          </div>
          {tuningError ? <p className="col-span-2 text-[11px] text-clay">{tuningError}</p> : null}
        </div>
      ) : null}
    </section>
  )
}
