import { useEffect, useState } from 'react'
import type { Task } from './types'

const thumbnailCache = new Map<string, Promise<string | null>>()
const maxCachedThumbnails = 160

function remember(key: string, loader: () => Promise<string | null>): Promise<string | null> {
  const existing = thumbnailCache.get(key)
  if (existing) return existing
  const pending = loader().catch(() => null)
  thumbnailCache.set(key, pending)
  void pending.then((value) => {
    if (!value && thumbnailCache.get(key) === pending) thumbnailCache.delete(key)
  })
  if (thumbnailCache.size > maxCachedThumbnails) {
    const oldest = thumbnailCache.keys().next().value
    if (oldest) thumbnailCache.delete(oldest)
  }
  return pending
}

function taskFilePath(task: Task): string {
  if (!task.folderPath) return task.filename
  return task.folderPath.endsWith('/')
    ? `${task.folderPath}${task.filename}`
    : `${task.folderPath}/${task.filename}`
}

async function loadTaskThumbnail(task: Task): Promise<string | null> {
  if (task.category !== 'video' && task.category !== 'image') return null
  const filePath = taskFilePath(task)
  if (filePath) {
    const local = await remember(`file:${filePath}`, () => window.ndm?.loadFileThumbnail(filePath) ?? Promise.resolve(null))
    if (local) return local
  }
  if (task.thumbnailURL) {
    return remember(`remote:${task.thumbnailURL}`, () => window.ndm?.loadThumbnail(task.thumbnailURL!) ?? Promise.resolve(null))
  }
  return null
}

export function useTaskThumbnail(task: Task): string | null {
  const [thumbnail, setThumbnail] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setThumbnail(null)
    void loadTaskThumbnail(task).then((source) => {
      if (current) setThumbnail(source)
    })
    return () => { current = false }
  }, [task.category, task.filename, task.folderPath, task.id, task.status, task.thumbnailURL])

  return thumbnail
}
