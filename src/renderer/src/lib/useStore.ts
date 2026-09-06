import { useEffect, useSyncExternalStore } from 'react'
import { getEngineError, getEngineStatus, getTasks, startClock, subscribe } from './store'

export function useTasks() {
  useEffect(() => startClock(), [])
  return useSyncExternalStore(subscribe, getTasks, getTasks)
}

export function useEngineStatus() {
  return useSyncExternalStore(subscribe, getEngineStatus, getEngineStatus)
}

export function useEngineError() {
  return useSyncExternalStore(subscribe, getEngineError, getEngineError)
}