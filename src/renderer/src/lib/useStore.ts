import { useEffect, useSyncExternalStore } from 'react'
import { getEngineStatus, getTasks, startClock, subscribe } from './store'

export function useTasks() {
  useEffect(() => startClock(), [])
  return useSyncExternalStore(subscribe, getTasks, getTasks)
}

export function useEngineStatus() {
  return useSyncExternalStore(subscribe, getEngineStatus, getEngineStatus)
}
