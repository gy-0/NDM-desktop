export type SpeedChartSample = { at: number; value: number }
export const SPEED_CHART_WINDOW_MS = 30_000
export type SpeedChartViewport = { end: number; peak: number }

/** Animate the coordinate system, never the measured values or timestamps. */
export function interpolateSpeedViewport(from: SpeedChartViewport, to: SpeedChartViewport, fraction: number): SpeedChartViewport {
  const t = Math.max(0, Math.min(1, fraction))
  const eased = 1 - (1 - t) ** 3
  return { end: from.end + (to.end - from.end) * eased, peak: from.peak + (to.peak - from.peak) * eased }
}

export function speedChartGeometry(samples: SpeedChartSample[], end: number, peak: number) {
  const points = samples.filter(s => Number.isFinite(s.at) && Number.isFinite(s.value)).map(s => ({
    x: 5 + (s.at - end + SPEED_CHART_WINDOW_MS) / SPEED_CHART_WINDOW_MS * 278,
    y: 66 - Math.max(0, s.value) / Math.max(1, peak) * 56
  }))
  // Straight connections between observations avoid introducing curve overshoot.
  // Offscreen coordinates are intentional: the SVG viewport clips them.
  const line = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const fill = points.length < 2 ? '' : `${line} L ${points[points.length - 1].x} 66 L ${points[0].x} 66 Z`
  return { points, line, fill }
}

/** Peak of the drawn line inside the window, including its clipped left edge. */
export function speedChartPeak(samples: SpeedChartSample[], end: number): number {
  const start = end - SPEED_CHART_WINDOW_MS
  const valid = samples.filter(sample => Number.isFinite(sample.at) && Number.isFinite(sample.value))
  let peak = 0
  for (let index = 0; index < valid.length; index++) {
    const sample = valid[index]
    if (sample.at >= start && sample.at <= end) peak = Math.max(peak, sample.value)
    const previous = valid[index - 1]
    if (previous && previous.at < start && sample.at >= start && sample.at > previous.at) {
      const fraction = (start - previous.at) / (sample.at - previous.at)
      const edgeValue = Math.max(0, previous.value) + (Math.max(0, sample.value) - Math.max(0, previous.value)) * fraction
      peak = Math.max(peak, edgeValue)
    }
  }
  return peak
}
