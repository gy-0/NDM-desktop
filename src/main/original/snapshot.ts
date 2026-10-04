import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// Wire shape consumed by the existing desktop task list. No renderer dependency.
type DownloadStatus = 'downloading' | 'paused' | 'waiting' | 'complete' | 'error' | 'incomplete'
type DownloadCategory = 'video' | 'audio' | 'document' | 'compressed' | 'application' | 'image' | 'misc'
export type OriginalSnapshotTask = {
  id: number; filename: string; title: string; url: string; linkType: string;
  category: DownloadCategory; status: DownloadStatus; fileSize: number;
  completedBytes: number; bytesPerSecond: number; connections: number; folderPath: string;
  segments: { id: number; start: number; end?: number; completed: number; fraction: number }[];
  progressFraction?: number; errorText?: string;
  diagnostic?: { title: string; message: string; summary: string; primaryAction: 'none' };
}

type Row = Record<string, unknown>
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid original-engine snapshot object')
  return value as Row
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid original-engine numeric field')
  return value
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid original-engine state flag')
  return value
}
const categories: Record<string, DownloadCategory> = {
  Video: 'video', Audio: 'audio', Document: 'document', Compressed: 'compressed',
  Application: 'application', Image: 'image', Misc: 'misc'
}

// A stale file from a dead process must never imply a live download or trigger
// completion actions. The owner supplies the PID of its current launched process.
export function mapOriginalSnapshot(value: unknown, expectedPID: number, now = Date.now()): { op: 'snapshot'; tasks: OriginalSnapshotTask[] } {
  const raw = object(value)
  if (integer(raw.pid) !== expectedPID || expectedPID <= 0) throw new Error('Original-engine snapshot process mismatch')
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time)
    || now - raw.time * 1000 > 5000 || raw.time * 1000 - now > 1000) throw new Error('Original-engine snapshot expired')
  if (!Array.isArray(raw.records) || !Array.isArray(raw.tasks) || raw.records.length > 100000
    || raw.tasks.length > raw.records.length) throw new Error('Invalid original-engine snapshot lists')
  const active = new Map<number, Row>()
  for (const entry of raw.tasks) {
    const task = object(entry), id = integer(task.id)
    if (!id || active.has(id) || text(task.key) !== String(id)) throw new Error('Ambiguous original-engine task identity')
    active.set(id, task)
  }
  const ids = new Set<number>()
  const tasks = raw.records.map((entry): OriginalSnapshotTask => {
    const record = object(entry), id = integer(record.id)
    if (!id || ids.has(id)) throw new Error('Duplicate original-engine record identity')
    ids.add(id)
    const live = active.get(id), statusText = text(record.status)
    const working = live ? flag(live.working) : false
    const authenticating = live ? flag(live.authenticating) : false
    const waiting = live ? flag(live.waiting) : false
    let status: DownloadStatus = 'incomplete'
    if (statusText === 'Complete') status = 'complete'
    else if (authenticating || waiting) status = 'waiting'
    else if (statusText.startsWith('Error')) status = 'error'
    else if (working) status = 'downloading'
    else if (statusText.startsWith('Paused')) status = 'paused'
    const fileSize = integer(record.filesize)
    const task: OriginalSnapshotTask = {
      id, filename: text(record.filename), title: text(record.pagetitle) || text(record.filename),
      url: text(record.url), linkType: text(record.ltype), category: categories[text(record.category)] ?? 'misc',
      status, fileSize, completedBytes: status === 'complete' ? fileSize : 0,
      bytesPerSecond: 0, connections: 0, segments: [], folderPath: text(record.folderpath)
    }
    if (!task.filename || !task.url || (status === 'complete' && !task.folderPath)) throw new Error('Incomplete original-engine record metadata')
    if (record.errortext && status === 'error') task.errorText = text(record.errortext)
    if (authenticating) task.diagnostic = {
      title: '需要身份验证', message: '服务器要求提供下载凭据', summary: '等待身份验证', primaryAction: 'none'
    }
    if (live?.engineProgress != null && status !== 'complete') {
      const progress = object(live.engineProgress)
      task.completedBytes = integer(progress.completedBytes)
      const speed = integer(progress.bytesPerSecond)
      if (fileSize > 0 && task.completedBytes > fileSize) throw new Error('Original-engine progress exceeds size')
      if (!Array.isArray(progress.segments)) throw new Error('Invalid original-engine segments')
      const segments = progress.segments.map(entry => {
        const segment = object(entry)
        return { start: integer(segment.start), completed: integer(segment.completed) }
      }).sort((a, b) => a.start - b.start)
      if (segments.reduce((sum, segment) => sum + segment.completed, 0) !== task.completedBytes) throw new Error('Original-engine segment progress mismatch')
      task.segments = segments.map((segment, index) => {
        const end = segments[index + 1]?.start ?? (fileSize || undefined)
        if (end !== undefined && (end <= segment.start || segment.completed > end - segment.start)) throw new Error('Invalid original-engine segment bounds')
        return { id: index, ...segment, ...(end === undefined ? {} : { end: end - 1 }),
          fraction: end === undefined ? 0 : segment.completed / (end - segment.start) }
      })
      if (working && !authenticating && !waiting && status === 'downloading') {
        task.bytesPerSecond = speed
        task.connections = segments.length
      }
    }
    // Persisted percentage is display-only, not an invented exact byte count.
    if (status !== 'complete' && !live?.engineProgress) {
      const match = /^(?:Paused \( )?(\d+(?:\.\d+)?)%(?: \))?$/.exec(statusText)
      if (match && Number(match[1]) <= 100) task.progressFraction = Number(match[1]) / 100
    }
    return task
  })
  if ([...active.keys()].some(id => !ids.has(id))) throw new Error('Original-engine task has no durable record')
  return { op: 'snapshot', tasks }
}

export async function readOriginalState(directory: string, expectedPID: number) {
  const bytes = await readFile(join(directory, 'snapshot.json'))
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Original-engine snapshot too large')
  const raw = object(JSON.parse(bytes.toString('utf8')))
  const snapshot = mapOriginalSnapshot(raw, expectedPID)
  const workers = (raw.tasks as unknown[]).map(entry => {
    const task = object(entry)
    return { id: integer(task.id), working: flag(task.working),
      authenticating: flag(task.authenticating), waiting: flag(task.waiting) }
  })
  const records = (raw.records as unknown[]).map(entry => {
    const record = object(entry)
    return { id: integer(record.id), url: text(record.url), method: text(record.method) }
  })
  return { snapshot, workers, records, time: raw.time as number }
}

export async function readOriginalSnapshot(directory: string, expectedPID: number): Promise<ReturnType<typeof mapOriginalSnapshot>> {
  return (await readOriginalState(directory, expectedPID)).snapshot
}
