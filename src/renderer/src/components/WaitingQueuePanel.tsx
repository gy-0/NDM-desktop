import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react'

type QueueTask = { id: number; filename: string }
type QueueReply = { ok: boolean; tasks?: QueueTask[]; error?: string }
const CONTROL = 'rounded-control border border-line p-2 text-fog hover:bg-raised hover:text-paper disabled:opacity-30'

async function readQueue(op = 'getWaitingQueue', extra: Record<string, unknown> = {}): Promise<QueueTask[]> {
  const result = await window.ndm?.request(op, extra) as QueueReply | undefined
  if (!result?.ok || !Array.isArray(result.tasks)) throw new Error(result?.error || '暂时无法读取等待队列。')
  return result.tasks
}

export function WaitingQueuePanel() {
  const [tasks, setTasks] = useState<QueueTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const generation = useRef(0)
  const moving = useRef(false)
  const latestQuery = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (!moving.current) {
          const query = ++latestQuery.current
          const next = await readQueue()
          if (!stopped && current === generation.current && !moving.current && query === latestQuery.current) { setTasks(next); setError(null) }
        }
      } catch (error) {
        if (!stopped && current === generation.current) setError(error instanceof Error ? error.message : '未能读取队列。')
      } finally {
        if (!stopped && current === generation.current) { if (!moving.current) setBusy(false); timer = setTimeout(() => void poll(), 1500) }
      }
    }
    void poll()
    return () => { stopped = true; generation.current++; clearTimeout(timer) }
  }, [])

  const move = async (index: number, direction: -1 | 1) => {
    if (moving.current || busy) return
    const current = generation.current
    latestQuery.current++
    moving.current = true; setBusy(true); setError(null); setActionError(null)
    const task = tasks[index]
    const beforeTaskID = direction < 0 ? tasks[index - 1]?.id : tasks[index + 2]?.id ?? null
    try {
      const confirmed = await readQueue('moveQueuedTask', { taskID: task.id, beforeTaskID, expectedIDs: tasks.map(task => task.id) })
      if (current === generation.current) setTasks(confirmed)
    } catch (error) {
      if (current === generation.current) setActionError(error instanceof Error ? error.message : '未能调整队列。')
      const latest = await readQueue().catch(() => null)
      if (latest && current === generation.current) setTasks(latest)
    } finally {
      moving.current = false
      if (current === generation.current) setBusy(false)
    }
  }

  return <section aria-label="等待队列" data-waiting-queue-panel>
    <p className="mb-3 text-label leading-relaxed text-mist">调整普通等待任务的执行顺序。已开始、预约、手动暂停和合集中的任务保留各自安排。</p>
    {(actionError || error) && <p role="alert" className="mb-3 text-label text-clay">{actionError || error}</p>}
    {tasks.length === 0 ? !error && <p className="text-label text-fog">{busy ? '正在读取队列…' : '当前没有可重排的等待任务。'}</p> : <ol className="space-y-2">
      {tasks.map((task, index) => <li key={task.id} className="flex items-center gap-2 rounded-panel border border-line px-3 py-2">
        <span className="w-5 shrink-0 font-sans text-label tabular-nums text-mist">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-label text-paper" title={task.filename}>{task.filename}</span>
        <button type="button" className={CONTROL} aria-label={`上移 ${task.filename}`} disabled={busy || index === 0} onClick={() => void move(index, -1)}><ArrowUp size={14} /></button>
        <button type="button" className={CONTROL} aria-label={`下移 ${task.filename}`} disabled={busy || index === tasks.length - 1} onClick={() => void move(index, 1)}><ArrowDown size={14} /></button>
      </li>)}
    </ol>}
    {busy && tasks.length > 0 && <p role="status" className="mt-2 flex items-center gap-2 text-label text-mist"><RefreshCw size={12} className="animate-spin" />正在确认队列顺序…</p>}
  </section>
}
