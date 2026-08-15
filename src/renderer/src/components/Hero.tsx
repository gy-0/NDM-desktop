import { Pause, Play } from 'lucide-react'
import { formatBytes, formatEta, formatSpeed, fractionOf, remainingSeconds } from '../lib/format'
import { toggle } from '../lib/store'
import { PHASE_LABEL, type Task } from '../lib/types'
import { useProgressStyle } from '../lib/presentationPrefs'
import { Connections } from './Connections'
import { LoadingMark } from './LoadingMark'
import { TypeMark } from './Marks'

export function Hero({ task }: { task: Task }) {
  const speed = formatSpeed(task.bytesPerSecond)
  const fraction = fractionOf(task)
  const eta = formatEta(remainingSeconds(task))
  const progressStyle = useProgressStyle()
  const activeSegments = task.segments.length

  return (
    <section className="relative overflow-hidden border-b border-line px-6 py-4">
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
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
          <p className="mt-1 truncate text-[11px] text-mist" title={task.title}>{task.title !== task.filename ? task.title : task.source}</p>
        </div>

        <div className="shrink-0 text-right">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="font-mono text-[24px] leading-none tabular-nums tracking-[-0.04em]">{speed.value}</span>
            <span className="text-[11px] text-mist">{speed.unit}</span>
          </div>
          <div className="mt-1 text-[11px] text-fog">剩余 {eta}</div>
        </div>

        <button
          type="button"
          onClick={() => toggle(task.id)}
          className="app-no-drag grid size-9 shrink-0 place-items-center rounded-full bg-raised text-fog shadow-[0_0_0_1px_var(--line-strong)] transition-[scale,color,background-color] duration-150 hover:text-paper active:scale-[0.96]"
          data-cuelume-press
          aria-label={task.status === 'downloading' ? '暂停下载' : '继续下载'}
          title={task.status === 'downloading' ? '暂停' : '继续'}
        >
          {task.status === 'downloading' ? <Pause size={15} strokeWidth={1.8} /> : <Play size={15} strokeWidth={1.8} className="translate-x-px" />}
        </button>
      </div>

      <div className="relative mt-3">
        <div className="flex items-center justify-between text-[10.5px] text-mist">
          <span className="tabular-nums">{formatBytes(task.completedBytes)} / {formatBytes(task.fileSize)}</span>
          <span className="tabular-nums text-fog">{Math.round(fraction * 100)}%</span>
        </div>
        <div className="mt-1.5">
          <Connections segments={task.segments} fraction={fraction} style={progressStyle} />
        </div>
        {progressStyle === 'segmented' && activeSegments > 1 ? (
          <div className="mt-1.5 text-right text-[9.5px] tracking-[0.05em] text-mist">
            {activeSegments} 个分段并行传输
          </div>
        ) : null}
      </div>
    </section>
  )
}
