import { ChevronRight, Pause, Play } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { formatBytes, formatSpeed, fractionOf, isDistinctTitle } from '../lib/format'
import { PHASE_LABEL, type Task } from '../lib/types'
import { useProgressStyle } from '../lib/presentationPrefs'
import { cue } from '../lib/sound'
import { Connections } from './Connections'
import { LoadingMark } from './LoadingMark'
import { TypeMark } from './Marks'
import { TransferField } from '../effects/metalforge/ProductMotion'

export function Hero({
  task,
  actionBusy,
  actionErrorId,
  position,
  total,
  onToggle,
  onNext,
  onInspect
}: {
  task: Task
  actionBusy: boolean
  actionErrorId?: string
  position: number
  total: number
  onToggle: (task: Task) => void
  onNext?: () => void
  onInspect: (task: Task) => void
}) {
  const live = task.status === 'downloading'
  const restingLabel = task.status === 'paused' ? '已暂停' : '等待继续'
  const speed = formatSpeed(task.bytesPerSecond)
  const fraction = fractionOf(task)
  const progressStyle = useProgressStyle()
  const reduceMotion = useReducedMotion()

  return (
    <section
      data-hero-state={task.status}
      className="relative overflow-hidden border-b border-line px-6 py-4"
      onClick={(event) => {
        if (!(event.target as Element).closest('button')) onInspect(task)
      }}
    >
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
      <TransferField progressFraction={fraction} identity={task.id} active={live} />
      <div className="relative grid">
        <AnimatePresence initial={false}>
          <motion.div
            key={task.id}
            data-hero-content={task.id}
            initial={reduceMotion ? false : { opacity: 0, y: 4, filter: 'blur(2px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3, filter: 'blur(2px)' }}
            transition={{ duration: reduceMotion ? 0.01 : 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative col-start-1 row-start-1"
          >
            <div className="flex items-center gap-4">
              <TypeMark category={task.category} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center justify-between gap-2.5 text-[10.5px] tracking-[0.06em] text-mist">
                  <span className="min-w-0 truncate">
                    {!live ? (
                      <span className="text-copper">{restingLabel}</span>
                    ) : task.phase === 'preparing' ? (
                      <LoadingMark label={PHASE_LABEL.preparing} />
                    ) : (
                      <span className={task.phase && task.phase !== 'transferring' ? 'text-copper' : ''}>
                        {task.phase && task.phase !== 'transferring' ? PHASE_LABEL[task.phase] : '正在下载'}
                      </span>
                    )}
                  </span>
                  {total > 1 && onNext ? (
                    <button
                      type="button"
                      data-hero-cycle
                      aria-label={`切换到下一个下载，当前第 ${position} 项，共 ${total} 项`}
                      title="切换焦点下载"
                      onClick={() => {
                        onNext()
                        cue('tick')
                      }}
                      className="app-no-drag inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-line/75 bg-raised/55 px-1.5 font-mono text-[9.5px] tracking-normal text-mist transition-[background-color,border-color,color,scale] duration-120 hover:border-line-strong hover:bg-raised hover:text-paper active:scale-[0.96]"
                    >
                      <span className="tabular-nums">{position}/{total}</span>
                      <ChevronRight size={10} strokeWidth={1.8} />
                    </button>
                  ) : null}
                </div>
                <h1 className="mt-1.5 truncate font-serif text-[23px] leading-[1.12] tracking-[-0.025em]" title={task.filename || task.title}>
                  {task.filename || task.title}
                </h1>
                <p className="mt-1 truncate text-[11px] text-mist" title={isDistinctTitle(task.title, task.filename) ? task.title : task.source}>
                  {isDistinctTitle(task.title, task.filename) ? task.title : task.source}
                </p>
              </div>

              {live ? (
                <div data-hero-speed className="w-[122px] shrink-0 text-right">
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span className="font-sans text-[26px] font-medium leading-none tabular-nums tracking-[-0.045em]">{speed.value}</span>
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-mist">{speed.unit}</span>
                  </div>
                </div>
              ) : (
                <div data-hero-rest-progress className="w-[122px] shrink-0 text-right">
                  <div className="font-sans text-[21px] font-medium leading-none tabular-nums tracking-[-0.035em] text-copper">
                    {formatBytes(task.completedBytes)}
                  </div>
                  <div className="mt-1.5 text-[10px] tracking-[0.04em] text-mist">已安全保留</div>
                </div>
              )}

              <button
                type="button"
                disabled={actionBusy}
                aria-describedby={actionErrorId}
                onClick={() => onToggle(task)}
                className="app-no-drag grid size-9 shrink-0 place-items-center rounded-full bg-raised text-fog shadow-[0_0_0_1px_var(--line-strong)] transition-[scale,color,background-color] duration-150 hover:text-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
                data-cuelume-press
                aria-label={live ? '暂停下载' : '继续下载'}
                title={live ? '暂停' : '继续'}
              >
                {live ? <Pause size={15} strokeWidth={1.8} /> : <Play size={15} strokeWidth={1.8} className="translate-x-px" />}
              </button>
            </div>

            <div data-hero-progress className="relative mt-4">
              <Connections segments={task.segments} fraction={fraction} fileSize={task.fileSize} style={progressStyle} />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}
