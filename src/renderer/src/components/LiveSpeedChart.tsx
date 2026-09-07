import { useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { formatSpeed } from '../lib/format'
import { interpolateSpeedViewport, speedChartGeometry, speedChartPeak, type SpeedChartSample, type SpeedChartViewport } from '../lib/speedChartGeometry'

const motionQuery = '(prefers-reduced-motion: reduce)'
const subscribeMotionPreference = (notify: () => void): (() => void) => {
  const media = window.matchMedia(motionQuery)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const readMotionPreference = (): boolean => window.matchMedia(motionQuery).matches
const serverMotionPreference = (): boolean => true

export function LiveSpeedChart({ samples, current }: { samples: SpeedChartSample[]; current: number }) {
  const reduceMotion = useSyncExternalStore(subscribeMotionPreference, readMotionPreference, serverMotionPreference)
  const speed = formatSpeed(current)
  const end = samples.at(-1)?.at ?? 0
  const peak = speedChartPeak(samples, end)
  const peakSpeed = formatSpeed(peak)
  const clipID = `speed-${useId().replace(/:/g, '')}`
  const viewport = useRef<SpeedChartViewport>({ end, peak })
  const lineRef = useRef<SVGPathElement>(null)
  const fillRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const hasHistory = useRef(samples.length > 0)
  const initial = speedChartGeometry(samples, end, peak)

  useLayoutEffect(() => {
    const target = { end, peak }
    const from = { ...viewport.current }
    let frame = 0
    let began: number | null = null
    const paint = (view: SpeedChartViewport): void => {
      viewport.current = view
      const geometry = speedChartGeometry(samples, view.end, view.peak)
      lineRef.current?.setAttribute('d', geometry.line)
      fillRef.current?.setAttribute('d', geometry.fill)
      const point = geometry.points.at(-1)
      if (point && dotRef.current) {
        dotRef.current.setAttribute('cx', String(point.x))
        dotRef.current.setAttribute('cy', String(point.y))
      }
    }
    const immediate = reduceMotion || !hasHistory.current || samples.length < 2 || end < from.end
    hasHistory.current = samples.length > 0
    if (immediate) { paint(target); return }
    // Every new snapshot starts from the last painted viewport, including an
    // interrupted animation. Sample values themselves remain authoritative.
    paint(from)
    const tick = (now: number): void => {
      began ??= now
      const fraction = Math.min(1, (now - began) / 280)
      paint(interpolateSpeedViewport(from, target, fraction))
      if (fraction < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [samples, end, peak, reduceMotion])

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-line/70 bg-ink/20" aria-label={`实时速度 ${speed.value} ${speed.unit}`}>
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.13em] text-mist">实时速度</span>
        <span className="font-sans text-[14px] font-medium tabular-nums tracking-[-0.025em] text-paper">{speed.value} <span className="text-[10px] font-normal text-mist">{speed.unit}</span></span>
      </div>
      <svg viewBox="0 0 288 76" preserveAspectRatio="none" className="mt-1 block h-[62px] w-full" role="img" aria-label={samples.length ? `最近 30 秒内的已观测吞吐曲线，曲线峰值 ${peakSpeed.value} ${peakSpeed.unit}` : '等待速度采样'}>
        <defs><clipPath id={clipID}><rect x="5" y="0" width="278" height="67" /></clipPath></defs>
        <g stroke="var(--line)" opacity="0.35" strokeDasharray="1 3">
          {[.25, .5, .75].map(fraction => <line key={fraction} x1="5" x2="283" y1={66 - fraction * 56} y2={66 - fraction * 56} />)}
        </g>
        <g stroke="var(--line)" opacity="0.22" strokeDasharray="1 3">
          {[5, 144, 283].map(x => <line key={x} x1={x} x2={x} y1="10" y2="66" />)}
        </g>
        <g clipPath={`url(#${clipID})`}>
          <path ref={fillRef} data-speed-fill d={initial.fill} fill="var(--accent)" opacity="0.11" />
          <path ref={lineRef} data-speed-path d={initial.line} fill="none" stroke="var(--accent)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {initial.points.length > 0 && <circle ref={dotRef} data-speed-point cx={initial.points.at(-1)!.x} cy={initial.points.at(-1)!.y} r="2" fill="var(--accent)" />}
        </g>
        <line x1="5" y1="66" x2="283" y2="66" stroke="var(--line)" opacity="0.7" />
      </svg>
      <div className="flex items-center justify-between px-3 pb-2 text-[10px] text-mist">
        <span>滚动 30 秒</span><span>{samples.length ? `曲线峰值 ${peakSpeed.value} ${peakSpeed.unit}` : '等待采样'}</span>
      </div>
    </section>
  )
}
