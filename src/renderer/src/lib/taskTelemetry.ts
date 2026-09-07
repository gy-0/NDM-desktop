import type { Task } from './types'
import { SPEED_CHART_WINDOW_MS, type SpeedChartSample } from './speedChartGeometry'

export type TaskTelemetry = { id: number; at: number; status: Task['status']; bytesPerSecond: number }
const listeners = new Map<number, Set<(sample: TaskTelemetry) => void>>()

export function subscribeTaskTelemetry(id: number, listener: (sample: TaskTelemetry) => void): () => void {
  const subscriptions = listeners.get(id) ?? new Set()
  subscriptions.add(listener)
  listeners.set(id, subscriptions)
  return () => {
    subscriptions.delete(listener)
    if (!subscriptions.size) listeners.delete(id)
  }
}

export function publishTaskTelemetry(task: Task, at: number, rawSpeed: unknown): void {
  const subscriptions = listeners.get(task.id)
  if (!subscriptions?.size || !Number.isSafeInteger(task.id) || !Number.isFinite(at)
    || typeof rawSpeed !== 'number' || !Number.isFinite(rawSpeed) || rawSpeed < 0) return
  const sample = { id: task.id, at, status: task.status, bytesPerSecond: rawSpeed }
  for (const listener of subscriptions) listener(sample)
}

export function appendSpeedTelemetry(previous: SpeedChartSample[], sample: TaskTelemetry): SpeedChartSample[] {
  if (sample.status !== 'downloading') return []
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.bytesPerSecond) || sample.bytesPerSecond < 0) return previous
  const last = previous.at(-1)
  if (last && (sample.at < last.at || sample.at - last.at > SPEED_CHART_WINDOW_MS)) {
    return [{ at: sample.at, value: sample.bytesPerSecond }]
  }
  if (last && sample.at - last.at < 500) return previous
  const next = [...previous, { at: sample.at, value: sample.bytesPerSecond }]
  const firstVisible = next.findIndex(point => point.at >= sample.at - SPEED_CHART_WINDOW_MS)
  return next.slice(Math.max(0, firstVisible - 1)).slice(-64)
}
