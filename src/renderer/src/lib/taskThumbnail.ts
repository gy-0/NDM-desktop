import { useEffect, useState } from 'react'
import type { Task } from './types'

export type TaskArtwork = {
  source: string
  kind: 'preview' | 'icon'
  installedPath?: string
}

const thumbnailCache = new Map<string, Promise<TaskArtwork | null>>()
const maxCachedThumbnails = 160

function remember(key: string, loader: () => Promise<TaskArtwork | null>): Promise<TaskArtwork | null> {
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

async function loadTaskThumbnail(task: Task): Promise<TaskArtwork | null> {
  const filePath = taskFilePath(task)
  const canPreviewLocal = task.status === 'complete' || task.category === 'video' || task.category === 'image'
  if (filePath && canPreviewLocal) {
    const local = await remember(`file:${filePath}`, async () => {
      const artwork = await window.ndm?.loadFileThumbnail(filePath)
      return artwork ? { source: artwork.dataURL, kind: artwork.kind, installedPath: artwork.installedPath } : null
    })
    if (local) return local
  }
  if (task.thumbnailURL) {
    return remember(`remote:${task.thumbnailURL}`, async () => {
      const source = await window.ndm?.loadThumbnail(task.thumbnailURL!)
      return source ? { source, kind: 'preview' } : null
    })
  }
  return null
}

export function useTaskThumbnail(task: Task): TaskArtwork | null {
  const [thumbnail, setThumbnail] = useState<TaskArtwork | null>(null)

  useEffect(() => {
    let current = true
    const filePath = taskFilePath(task)
    setThumbnail(null)
    void loadTaskThumbnail(task).then((source) => {
      if (current) setThumbnail(source)
    })
    const stop = window.ndm?.onEvent((message) => {
      if (
        message.op !== 'installProgress' ||
        message.phase !== 'complete' ||
        message.path !== filePath
      ) return
      thumbnailCache.delete(`file:${filePath}`)
      void loadTaskThumbnail(task).then((source) => {
        if (current) setThumbnail(source)
      })
    })
    return () => {
      current = false
      stop?.()
    }
  }, [task.category, task.filename, task.folderPath, task.id, task.status, task.thumbnailURL])

  return thumbnail
}
