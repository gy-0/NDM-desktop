import { motion } from 'framer-motion'
import { Pause, Play } from 'lucide-react'
import { formatBytes, formatEta, formatSpeed, fractionOf, remainingSeconds } from '../lib/format'
import { toggle } from '../lib/store'
import { PHASE_LABEL, type Task } from '../lib/types'
import { Connections } from './Connections'
import { LoadingMark } from './LoadingMark'
import { TypeMark } from './Marks'

export function Hero({ task }: { task: Task }) {
  const speed = formatSpeed(task.bytesPerSecond)
  const fraction = fractionOf(task)
  const eta = formatEta(remainingSeconds(task))

  return (
    <section className="relative overflow-hidden border-b border-line px-8 pb-7 pt-3">
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
      <div className="relative flex items-start justify-between gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.16em] text-mist">
            {task.phase === 'preparing' ? (
              <LoadingMark label="正在解析" />
            ) : (
              <>
                <span>正在下载</span>
                {task.phase ? <span className="text-copper">{PHASE_LABEL[task.phase]}</span> : null}
              </>
            )}
            {task.source ? <span>{task.source}</span> : null}
          </div>
          <h1 className="mt-3 truncate font-serif text-[34px] leading-[1.05] tracking-tight">
            {task.title}
          </h1>
          <p className="mt-2 truncate font-mono text-[12px] text-mist">{task.filename}</p>
          <div className="mt-6 max-w-[520px]">
            <div className="mb-2 flex items-baseline justify-between text-[12px] text-fog">
              <span>
                {formatBytes(task.completedBytes)}
                <span className="text-mist"> / {formatBytes(task.fileSize)}</span>
              </span>
              <span>{Math.round(fraction * 100)}%</span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-line">
              <motion.div
                className="h-full bg-copper"
                animate={{ width: `${fraction * 100}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 24 }}
              />
            </div>
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-mist">
                {task.connections} 个连接
              </div>
              <Connections segments={task.segments} tall />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end pt-1">
          <TypeMark category={task.category} size="lg" />
          <div className="mt-6 text-right">
            <div className="flex items-baseline justify-end gap-1.5">
              <span className="font-serif text-[56px] leading-none tracking-tight">{speed.value}</span>
              <span className="text-[13px] text-mist">{speed.unit}</span>
            </div>
            <div className="mt-2 text-[12px] text-fog">剩余 {eta}</div>
          </div>
          <button
            type="button"
            onClick={() => toggle(task.id)}
            className="app-no-drag mt-6 inline-flex items-center gap-2 rounded-full border border-line-strong bg-raised px-3.5 py-1.5 text-[13px] text-paper transition-transform duration-150 active:scale-[0.96]"
            data-cuelume-press
            data-cuelume-release
          >
            {task.status === 'downloading' ? <Pause size={13} /> : <Play size={13} />}
            {task.status === 'downloading' ? '暂停' : '继续'}
          </button>
        </div>
      </div>
    </section>
  )
}
