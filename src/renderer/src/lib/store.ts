import type { AddDownloadOptions, DownloadCategory, DownloadStatus, EngineSettings, FilterId, Segment, Task } from './types'

const listeners = new Set<() => void>()
let tasks: Task[] = []
let engineStatus: EngineStatus = 'connecting'

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTasks(): Task[] {
  return tasks
}

export function getEngineStatus(): EngineStatus {
  return engineStatus
}

function asTask(raw: Record<string, unknown>): Task {
  const category = String(raw.category ?? 'misc') as DownloadCategory
  const status = String(raw.status ?? 'waiting') as DownloadStatus
  const segments = Array.isArray(raw.segments)
    ? (raw.segments as Array<Record<string, unknown>>).map((segment) => ({
        id: Number(segment.id ?? 0),
        fraction: Number(segment.fraction ?? 0)
      }))
    : []
  return {
    id: Number(raw.id),
    filename: String(raw.filename ?? ''),
    title: String(raw.title || raw.filename || '未命名'),
    url: String(raw.url ?? ''),
    source: raw.source ? String(raw.source) : undefined,
    category,
    status,
    phase: raw.phase ? (String(raw.phase) as Task['phase']) : undefined,
    fileSize: Number(raw.fileSize ?? 0),
    completedBytes: Number(raw.completedBytes ?? 0),
    bytesPerSecond: Number(raw.bytesPerSecond ?? 0),
    connections: Number(raw.connections ?? 0),
    segments: segments as Segment[],
    errorText: raw.errorText ? String(raw.errorText) : undefined,
    folderPath: String(raw.folderPath ?? '')
  }
}

function applySnapshot(rows: unknown): void {
  if (!Array.isArray(rows)) return
  tasks = rows.map((row) => asTask(row as Record<string, unknown>))
  emit()
  window.ndm?.notifySnapshot?.(tasks)
}

export async function pauseAll(): Promise<void> {
  await window.ndm?.request('pauseAll')
}

export async function resumeAll(): Promise<void> {
  await window.ndm?.request('resumeAll')
}

export function counts(): Record<FilterId, number> {
  const by = (pred: (task: Task) => boolean): number => tasks.filter(pred).length
  return {
    all: tasks.length,
    active: by((task) => task.status === 'downloading'),
    queued: by((task) => task.status === 'waiting'),
    paused: by((task) => task.status === 'paused' || task.status === 'incomplete'),
    completed: by((task) => task.status === 'complete'),
    failed: by((task) => task.status === 'error'),
    video: by((task) => task.category === 'video'),
    audio: by((task) => task.category === 'audio'),
    document: by((task) => task.category === 'document'),
    compressed: by((task) => task.category === 'compressed'),
    application: by((task) => task.category === 'application'),
    image: by((task) => task.category === 'image'),
    misc: by((task) => task.category === 'misc')
  }
}

export function filterTasks(filter: FilterId, query: string): Task[] {
  const q = query.trim().toLowerCase()
  return tasks.filter((task) => {
    const matchFilter =
      filter === 'all' ||
      (filter === 'active' && task.status === 'downloading') ||
      (filter === 'queued' && task.status === 'waiting') ||
      (filter === 'paused' && (task.status === 'paused' || task.status === 'incomplete')) ||
      (filter === 'completed' && task.status === 'complete') ||
      (filter === 'failed' && task.status === 'error') ||
      task.category === filter
    if (!matchFilter) return false
    if (!q) return true
    return [task.filename, task.title, task.source, task.url].some((value) =>
      value?.toLowerCase().includes(q)
    )
  })
}

export async function addFromUrl(options: string | AddDownloadOptions): Promise<Task> {
  const params = typeof options === 'string' ? { url: options } : options
  const reply = (await window.ndm?.request('add', params as Record<string, unknown>)) as { task?: Record<string, unknown> }
  if (!reply?.task) throw new Error('添加失败')
  const task = asTask(reply.task)
  if (!tasks.some((row) => row.id === task.id)) {
    tasks = [task, ...tasks]
    emit()
  }
  return task
}

export async function toggle(id: number): Promise<void> {
  const task = tasks.find((row) => row.id === id)
  if (!task) return
  if (task.status === 'downloading') await window.ndm?.request('pause', { taskID: id })
  else await window.ndm?.request('resume', { taskID: id })
}

export async function restartTask(id: number): Promise<void> {
  await window.ndm?.request('restart', { taskID: id })
}

export async function remove(id: number, deleteFile = false): Promise<void> {
  await window.ndm?.request('remove', { taskID: id, deleteFile })
  tasks = tasks.filter((task) => task.id !== id)
  emit()
}

export async function revealFile(filePath: string): Promise<boolean> {
  if (window.ndm?.revealFile) {
    return window.ndm.revealFile(filePath)
  }
  return false
}

export async function openFile(filePath: string): Promise<string> {
  if (window.ndm?.openPath) {
    return window.ndm.openPath(filePath)
  }
  return 'Not supported'
}

export async function chooseFolder(defaultPath?: string): Promise<string | null> {
  if (window.ndm?.selectFolder) {
    return window.ndm.selectFolder(defaultPath)
  }
  return null
}

export async function copyToClipboard(text: string): Promise<void> {
  if (window.ndm?.writeClipboard) {
    await window.ndm.writeClipboard(text)
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
  }
}

export async function readClipboard(): Promise<string> {
  if (window.ndm?.readClipboard) {
    return window.ndm.readClipboard()
  } else if (navigator.clipboard) {
    return navigator.clipboard.readText()
  }
  return ''
}

export async function getEngineSettings(): Promise<EngineSettings | null> {
  const reply = (await window.ndm?.request('getSettings')) as { settings?: EngineSettings }
  return reply?.settings ?? null
}

export async function updateEngineSettings(settings: Partial<EngineSettings>): Promise<EngineSettings | null> {
  const reply = (await window.ndm?.request('updateSettings', settings as Record<string, unknown>)) as {
    settings?: EngineSettings
  }
  return reply?.settings ?? null
}

export async function probeMedia(url: string): Promise<MediaProbeResult | null> {
  try {
    const reply = (await window.ndm?.request('probeMedia', { url })) as {
      ok?: boolean
      title?: string
      duration?: number
      formats?: MediaFormat[]
    }
    if (reply && reply.ok) {
      return {
        title: reply.title ?? '',
        duration: reply.duration ?? 0,
        formats: reply.formats ?? []
      }
    }
  } catch {
    // Media probing not supported or failed for non-video URL
  }
  return null
}

export async function quickLook(filePath: string): Promise<boolean> {
  return (await window.ndm?.quickLook(filePath)) ?? false
}

export async function openExternal(url: string): Promise<boolean> {
  return (await window.ndm?.openExternal(url)) ?? false
}

export function startClock(): () => void {
  const api = window.ndm
  if (!api) {
    engineStatus = 'down'
    emit()
    return () => undefined
  }
  void api.status().then((status) => {
    engineStatus = status
    emit()
  })
  const offEvent = api.onEvent((message) => {
    if (message.op === 'snapshot') applySnapshot(message.tasks)
  })
  const offStatus = api.onStatus((status) => {
    engineStatus = status
    emit()
  })
  return () => {
    offEvent()
    offStatus()
  }
}

