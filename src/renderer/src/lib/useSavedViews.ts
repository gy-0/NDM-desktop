import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskSort } from './taskList'
import { addSavedView, parseSavedViews, removeSavedView, renameSavedView, SAVED_VIEWS_KEY, serializeSavedViews, type LibraryViewCriteria, type SavedView, type SavedViewMutationResult, type ViewTime } from './savedViews'

function read(): SavedView[] { try { return parseSavedViews(localStorage.getItem(SAVED_VIEWS_KEY)) } catch { return [] } }

/** View preferences have their own storage; no task or engine mutation is involved. */
export function useSavedViews() {
  const [views, setViews] = useState(read)
  const [error, setError] = useState<string | null>(null)
  const viewsRef = useRef(views)
  viewsRef.current = views

  useEffect(() => {
    const receive = (event: StorageEvent): void => {
      if (event.key !== SAVED_VIEWS_KEY && event.key !== null) return
      const next = read()
      viewsRef.current = next
      setViews(next)
    }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [])

  const commit = useCallback((change: ReturnType<typeof addSavedView>): SavedViewMutationResult => {
    // Validation belongs to the initiating form; shared errors describe storage failures.
    if (!change.ok) return change
    try {
      localStorage.setItem(SAVED_VIEWS_KEY, serializeSavedViews(change.views))
      viewsRef.current = change.views
      setViews(change.views)
      setError(null)
      return { ok: true, id: change.id }
    } catch {
      const message = '未能保存视图，请重试。'
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  const save = useCallback((name: string, criteria: LibraryViewCriteria, sort: TaskSort) => commit(addSavedView(viewsRef.current, name, criteria, sort)), [commit])
  const rename = useCallback((id: string, name: string) => commit(renameSavedView(viewsRef.current, id, name)), [commit])
  const remove = useCallback((id: string) => commit(removeSavedView(viewsRef.current, id)), [commit])
  return { views, error, save, rename, remove, clearError: () => setError(null) }
}

/** Relative views refresh across midnight and when returning to an idle window. */
export function useViewClock(time: ViewTime): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const refresh = (): void => setNow(Date.now())
    refresh()
    if (time === 'any') return
    const interval = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh) }
  }, [time])
  return now
}
