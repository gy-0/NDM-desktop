import { ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { formatBytes, formatSpeed, fractionOf, isDistinctTitle } from '../lib/format'
import { PHASE_LABEL, type Task } from '../lib/types'
import { useProgressStyle } from '../lib/presentationPrefs'
import { cue } from '../lib/sound'
import { Connections, type ConnectionsHandle } from './Connections'
import { LoadingMark } from './LoadingMark'
import { TypeMark } from './Marks'
import { TransferField, type TransferFieldHandle } from '../effects/metalforge/ProductMotion'
import { advanceProgressMotion, createProgressMotion, type ProgressMotion } from '../effects/metalforge/progressMotion'

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

  // One shared motion entity drives both visual tracks (the shader liquid layer
  // and the segmented bar) so the Hero always paints a single coherent phase
  // rather than two independent 4 Hz interpolators. Resets when the focused
  // task changes so a new download starts from a clean front.
  const sharedMotionRef = useRef<ProgressMotion>(createProgressMotion(fraction))
  const sharedTaskRef = useRef(task.id)
  if (sharedTaskRef.current !== task.id) {
    sharedTaskRef.current = task.id
    sharedMotionRef.current = createProgressMotion(fraction)
  }
  sharedMotionRef.current.targetProgress = fraction
  if (!live) {
    sharedMotionRef.current.progress = fraction
    sharedMotionRef.current.lastNowMs = null
  }
  const sharedMotion = sharedMotionRef.current

  // One single rAF loop drives BOTH visual tracks — the DOM segment bar and
  // the WebGPU liquid layer. Previous iterations advanced the shared motion on
  // two independent rAFs (Connections + useFxRunner), so a hidden or offscreen
  // shader hung while the bar kept winding the clock, and the liquid warp
  // jumped several seconds the moment it came back. Now `Connections` and
  // `TransferField` are read-only: they consume `sharedMotion` and paint only
  // when this loop calls them, so every consumer sees the exact same phase.
  // When `active=false` (paused/complete), the loop freezes the clock by not
  // advancing, so resuming continues from the frozen value instead of jumping.
  const transferRef = useRef<TransferFieldHandle | null>(null)
  const connectionsRef = useRef<ConnectionsHandle | null>(null)
  const activeRef = useRef(live)
  activeRef.current = live
  const fractionRef = useRef(fraction)
  fractionRef.current = fraction
  const heroRef = useRef<HTMLElement | null>(null)
  const heroVisibleRef = useRef(true)

  useEffect(() => {
    // Mirror the shader's own gate at the composite level: the host must not
    // wind the shared clock while the liquid canvas cannot render, or its warp
    // would jump the moment the Hero scrolls back into view.
    const node = heroRef.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => {
      heroVisibleRef.current = entry?.isIntersecting ?? false
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (reduceMotion) return
    let frame = 0
    const tick = (nowMs: number): void => {
      // Freeze the whole motion entity while the task is not live, the Hero is
      // off-screen, or the document is hidden: the liquid shader's own gate
      // skips those frames, so advancing here would wind warp/activity for
      // frames nobody sees and make the clock jump on return.
      if (activeRef.current && heroVisibleRef.current && document.visibilityState === 'visible') {
        const motion = sharedMotionRef.current
        advanceProgressMotion(motion, nowMs, fractionRef.current)
      }
      const motion = sharedMotionRef.current
      connectionsRef.current?.paint(motion, nowMs)
      transferRef.current?.render(nowMs)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
    }
    // The loop must not restart when fraction/style change; it reads the latest
    // values through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion])

  return (
    <section
      ref={heroRef}
      data-hero-state={task.status}
      className="relative overflow-hidden border-b border-line px-6 py-4"
      onClick={(event) => {
        if (!(event.target as Element).closest('button')) onInspect(task)
      }}
    >
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
      <TransferField progressFraction={fraction} identity={task.id} active={live}
        externalMotion={sharedMotion}
        manualRender={!reduceMotion}
        ref={transferRef}
      />
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
              <Connections
                segments={task.segments}
                fraction={fraction}
                fileSize={task.fileSize}
                style={progressStyle}
                sharedMotion={null}
                hostDriven={!reduceMotion}
                ref={connectionsRef}
              />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}
