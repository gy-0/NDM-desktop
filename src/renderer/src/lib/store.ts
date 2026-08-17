import type {
  AddDownloadOptions,
  AddMediaOptions,
  CompletionArtifact,
  DownloadCategory,
  DownloadStatus,
  EngineSettings,
  FilterId,
  MediaFormat,
  MediaCollectionScope,
  MediaContainerPreference,
  MediaProbeResult,
  StorageConfidenceResult,
  Segment,
  Task
} from './types'
import { looksLikeOrdinaryFileDownload } from './format'

const listeners = new Set<() => void>()
let tasks: Task[] = []
let engineStatus: EngineStatus = 'connecting'
// The main process must not treat a partial-only view as the notification
// baseline: before the first full snapshot, "new complete task" cannot be
// distinguished from "historical task we simply had not seen yet".
let hasFullSnapshot = false

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
        fraction: Number(segment.fraction ?? 0),
        start: segment.start == null ? undefined : Number(segment.start),
        end: segment.end == null ? undefined : Number(segment.end),
        completed: segment.completed == null ? undefined : Number(segment.completed)
      }))
    : []
  const diagnostic = raw.diagnostic && typeof raw.diagnostic === 'object'
    ? raw.diagnostic as Record<string, unknown>
    : null
  const mediaOptions = raw.mediaOptions && typeof raw.mediaOptions === 'object'
    ? raw.mediaOptions as Record<string, unknown>
    : null
  const collection = raw.collection && typeof raw.collection === 'object'
    ? raw.collection as Record<string, unknown>
    : null
  return {
    id: Number(raw.id),
    filename: String(raw.filename ?? ''),
    title: String(raw.title || raw.filename || '未命名'),
    url: String(raw.url ?? ''),
    source: raw.source ? String(raw.source) : undefined,
    pageURL: raw.pageURL ? String(raw.pageURL) : undefined,
    thumbnailURL: raw.thumbnailURL ? String(raw.thumbnailURL) : undefined,
    category,
    status,
    phase: raw.phase ? (String(raw.phase) as Task['phase']) : undefined,
    fileSize: Number(raw.fileSize ?? 0),
    completedBytes: Number(raw.completedBytes ?? 0),
    progressFraction: raw.progressFraction == null ? undefined : Number(raw.progressFraction),
    bytesPerSecond: Number(raw.bytesPerSecond ?? 0),
    connections: Number(raw.connections ?? 0),
    bandwidthLimit: raw.bandwidthLimit == null ? undefined : Number(raw.bandwidthLimit),
    startAt: raw.startAt == null ? undefined : Number(raw.startAt),
    segments: segments as Segment[],
    errorText: raw.errorText ? String(raw.errorText) : undefined,
    diagnostic: diagnostic ? {
      title: String(diagnostic.title ?? ''),
      message: String(diagnostic.message ?? ''),
      summary: String(diagnostic.summary ?? ''),
      primaryAction: String(diagnostic.primaryAction ?? 'none') as NonNullable<Task['diagnostic']>['primaryAction']
    } : undefined,
    mediaOptions: mediaOptions ? {
      container: String(mediaOptions.container ?? 'compatibleMP4') as NonNullable<Task['mediaOptions']>['container'],
      subtitleLanguage: mediaOptions.subtitleLanguage ? String(mediaOptions.subtitleLanguage) : undefined
    } : undefined,
    collection: collection ? {
      id: String(collection.id ?? ''),
      title: String(collection.title ?? ''),
      index: Number(collection.index ?? 0),
      count: Number(collection.count ?? 0)
    } : undefined,
    folderPath: String(raw.folderPath ?? '')
  }
}

function sameSegments(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].fraction !== b[i].fraction) return false
  }
  return true
}

function sameTask(a: Task, b: Task): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.phase === b.phase &&
    a.completedBytes === b.completedBytes &&
    a.progressFraction === b.progressFraction &&
    a.bytesPerSecond === b.bytesPerSecond &&
    a.fileSize === b.fileSize &&
    a.connections === b.connections &&
    a.bandwidthLimit === b.bandwidthLimit &&
    a.startAt === b.startAt &&
    a.title === b.title &&
    a.filename === b.filename &&
    a.url === b.url &&
    a.source === b.source &&
    a.pageURL === b.pageURL &&
    a.thumbnailURL === b.thumbnailURL &&
    a.category === b.category &&
    a.errorText === b.errorText &&
    a.diagnostic?.title === b.diagnostic?.title &&
    a.diagnostic?.message === b.diagnostic?.message &&
    a.diagnostic?.summary === b.diagnostic?.summary &&
    a.diagnostic?.primaryAction === b.diagnostic?.primaryAction &&
    a.mediaOptions?.container === b.mediaOptions?.container &&
    a.mediaOptions?.subtitleLanguage === b.mediaOptions?.subtitleLanguage &&
    a.collection?.id === b.collection?.id &&
    a.collection?.title === b.collection?.title &&
    a.collection?.index === b.collection?.index &&
    a.collection?.count === b.collection?.count &&
    a.folderPath === b.folderPath &&
    sameSegments(a.segments, b.segments)
  )
}

function notifyMainProcess(): void {
  window.ndm?.notifySnapshot?.(
    tasks.map((task) => ({
      id: task.id,
      title: task.title,
      bytesPerSecond: task.bytesPerSecond,
      filename: task.filename,
      status: task.status,
      folderPath: task.folderPath,
      fileSize: task.fileSize,
      completedBytes: task.completedBytes
    })),
    hasFullSnapshot
  )
}

// Snapshots arrive at 4Hz while downloading. Keep previous object identities
// for unchanged rows so memoized components skip re-rendering, and drop the
// snapshot entirely when nothing changed.
function applySnapshot(rows: unknown): void {
  if (!Array.isArray(rows)) return
  hasFullSnapshot = true
  const prevById = new Map(tasks.map((task) => [task.id, task]))
  let changed = rows.length !== tasks.length
  const next = rows.map((row, index) => {
    const parsed = asTask(row as Record<string, unknown>)
    const prev = prevById.get(parsed.id)
    if (prev && sameTask(prev, parsed)) {
      if (tasks[index] !== prev) changed = true
      return prev
    }
    changed = true
    return parsed
  })
  if (!changed) return
  tasks = next
  emit()
  notifyMainProcess()
}

function applyPartialSnapshot(rows: unknown): void {
  if (!Array.isArray(rows)) return
  const updates = new Map(
    rows.map((row) => {
      const parsed = asTask(row as Record<string, unknown>)
      return [parsed.id, parsed] as const
    })
  )
  let changed = false
  const next = tasks.map((task) => {
    const update = updates.get(task.id)
    if (!update) return task
    updates.delete(task.id)
    if (sameTask(task, update)) return task
    changed = true
    return update
  })
  if (updates.size > 0) {
    changed = true
    next.unshift(...updates.values())
  }
  if (!changed) return
  tasks = next
  emit()
  notifyMainProcess()
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
  if (!params.formatID && /^https?:\/\//i.test(params.url) && !looksLikeOrdinaryFileDownload(params.url)) {
    try {
      const probe = await probeMedia(params.url)
      if (probe?.formats.length) {
        return (await addMedia({
          url: params.url,
          folderPath: params.folderPath,
          filename: params.filename,
          formatID: probe.formats[0].id,
          container: 'compatibleMP4',
          collectionScope: 'current'
        })).task
      }
    } catch {
      // Probe failed; the Neat HTTP engine still downloads the URL as a file.
    }
  }
  const reply = (await window.ndm?.request('add', params)) as { task?: Record<string, unknown> }
  if (!reply?.task) throw new Error('添加失败')
  const task = asTask(reply.task)
  if (!tasks.some((row) => row.id === task.id)) {
    tasks = [task, ...tasks]
    emit()
  }
  return task
}

export async function addMedia(options: AddMediaOptions): Promise<{ task: Task; count: number }> {
  const reply = (await window.ndm?.request('addMedia', options)) as {
    task?: Record<string, unknown>
    tasks?: Record<string, unknown>[]
  }
  if (!reply?.task) throw new Error('添加媒体任务失败')
  const created = (reply.tasks?.length ? reply.tasks : [reply.task]).map(asTask)
  const createdIDs = new Set(created.map((task) => task.id))
  tasks = [...created, ...tasks.filter((task) => !createdIDs.has(task.id))]
  emit()
  return { task: created[0], count: created.length }
}

export async function findDuplicate(urls: string[]): Promise<Task | null> {
  const reply = (await window.ndm?.request('findDuplicate', { urls })) as {
    duplicate?: Record<string, unknown>
  }
  return reply?.duplicate ? asTask(reply.duplicate) : null
}

export async function toggle(id: number): Promise<void> {
  const task = tasks.find((row) => row.id === id)
  if (!task) return
  if (task.status === 'downloading') await window.ndm?.request('pause', { taskID: id })
  else await window.ndm?.request('resume', { taskID: id })
}

export async function pauseCollection(collectionID: string): Promise<void> {
  await window.ndm?.request('pauseCollection', { collectionID })
}

export async function resumeCollection(collectionID: string): Promise<void> {
  await window.ndm?.request('resumeCollection', { collectionID })
}

export async function restartTask(id: number): Promise<void> {
  await window.ndm?.request('restart', { taskID: id })
}

export async function scheduleTask(id: number, startAt: number | null): Promise<void> {
  await window.ndm?.request('schedule', { taskID: id, startAt })
}

export async function setTaskConnections(id: number, connections: number): Promise<void> {
  await window.ndm?.request('setConnections', { taskID: id, connections })
}

export async function setTaskBandwidth(id: number, bandwidthLimit: number): Promise<void> {
  await window.ndm?.request('setBandwidth', { taskID: id, bandwidthLimit })
}

export async function getCompletionStack(id: number): Promise<CompletionArtifact[]> {
  const reply = (await window.ndm?.request('completionStack', { taskID: id })) as {
    artifacts?: Array<Record<string, unknown>>
  }
  if (!Array.isArray(reply?.artifacts)) return []
  return reply.artifacts.flatMap((raw): CompletionArtifact[] => {
    const kind = String(raw.kind ?? '') as CompletionArtifact['kind']
    const name = String(raw.name ?? '')
    const path = String(raw.path ?? '')
    if (!['primary', 'subtitle', 'cover', 'audio', 'metadata', 'other'].includes(kind) || !name || !path) {
      return []
    }
    return [{
      kind,
      name,
      path,
      byteCount: Math.max(0, Number(raw.byteCount) || 0)
    }]
  })
}

export async function renewTask(id: number, url: string): Promise<Task> {
  const reply = (await window.ndm?.request('renew', { taskID: id, url, autoStart: true })) as {
    task?: Record<string, unknown>
  }
  if (!reply?.task) throw new Error('更新链接失败')
  const updated = asTask(reply.task)
  tasks = tasks.map((task) => task.id === id ? updated : task)
  emit()
  return updated
}

export async function remove(id: number, deleteFile = false): Promise<void> {
  await window.ndm?.request('remove', { taskID: id, deleteFile })
  tasks = tasks.filter((task) => task.id !== id)
  emit()
}

// One engine op and one snapshot rebroadcast for the whole batch — removing
// rows one by one refetches the entire library per row.
export async function removeMany(ids: number[], deleteFile = false): Promise<void> {
  if (ids.length === 0) return
  if (ids.length === 1) return remove(ids[0], deleteFile)
  await window.ndm?.request('removeMany', { taskIDs: ids, deleteFile })
  const removed = new Set(ids)
  tasks = tasks.filter((task) => !removed.has(task.id))
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

export async function shareFile(filePath: string): Promise<boolean> {
  return (await window.ndm?.shareFile(filePath)) ?? false
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

export async function probeMedia(url: string, cookieBrowser?: string): Promise<MediaProbeResult | null> {
  try {
    const reply = (await window.ndm?.request('probeMedia', { url, ...(cookieBrowser ? { cookieBrowser } : {}) })) as {
      ok?: boolean
      title?: string
      duration?: number
      thumbnailURL?: string
      mediaURL?: string
      formats?: MediaFormat[]
      subtitles?: MediaProbeResult['subtitles']
      collection?: MediaProbeResult['collection']
      duplicateCurrent?: Record<string, unknown>
      duplicateCollection?: Record<string, unknown>
      errorKind?: MediaProbeResult['errorKind']
      error?: string
    }
    if (reply && reply.ok) {
      return {
        title: reply.title ?? '',
        duration: reply.duration ?? 0,
        thumbnailURL: reply.thumbnailURL,
        mediaURL: reply.mediaURL,
        formats: reply.formats ?? [],
        subtitles: reply.subtitles ?? [],
        collection: reply.collection,
        duplicateCurrent: reply.duplicateCurrent ? asTask(reply.duplicateCurrent) : undefined,
        duplicateCollection: reply.duplicateCollection ? asTask(reply.duplicateCollection) : undefined
      }
    }
    if (reply?.errorKind) {
      return {
        title: '',
        duration: 0,
        formats: [],
        subtitles: [],
        errorKind: reply.errorKind,
        errorMessage: reply.error
      }
    }
  } catch {
    // Media probing not supported or failed for non-video URL
  }
  return null
}

export async function checkStorage(
  folderPath: string,
  format: MediaFormat,
  options?: {
    url: string
    collectionScope: MediaCollectionScope
    container: MediaContainerPreference
  }
): Promise<StorageConfidenceResult | null> {
  const compact = options?.container === 'compactMKV'
  const reply = (await window.ndm?.request('checkStorage', {
    folderPath,
    finalBytes: compact ? format.compactApproximateBytes : format.approximateBytes,
    componentBytes: compact ? format.compactComponentBytes : format.componentBytes,
    formatID: format.id,
    ...(options ?? {})
  })) as ({ ok?: boolean } & StorageConfidenceResult) | undefined
  return reply?.ok ? reply : null
}

export async function quickLook(filePath: string): Promise<boolean> {
  return (await window.ndm?.quickLook(filePath)) ?? false
}

export async function openPath(path: string): Promise<string> {
  return (await window.ndm?.openPath(path)) ?? ''
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

  const fetchTasks = (): void => {
    void api.request('list').then((reply: unknown) => {
      const res = reply as { tasks?: unknown[] }
      if (res && Array.isArray(res.tasks)) {
        applySnapshot(res.tasks)
      }
    }).catch(() => {
      // Ignore if not ready yet
    })
  }

  void api.status().then((status) => {
    engineStatus = status
    emit()
    if (status === 'live') fetchTasks()
  })

  // Initial fetch attempt immediately
  fetchTasks()

  const offEvent = api.onEvent((message) => {
    if (message.op === 'snapshot') {
      if (message.partial === true) applyPartialSnapshot(message.tasks)
      else applySnapshot(message.tasks)
    }
  })

  const offStatus = api.onStatus((status) => {
    engineStatus = status
    emit()
    if (status === 'live') fetchTasks()
  })

  return () => {
    offEvent()
    offStatus()
  }
}
