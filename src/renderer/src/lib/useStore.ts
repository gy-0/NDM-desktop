import { useEffect, useSyncExternalStore } from 'react'
import { getLibraryReady, getEngineError, getEngineStatus, getTasks, startClock, subscribe } from './store'

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
export function useLibraryReady() {
  return useSyncExternalStore(subscribe, getLibraryReady, getLibraryReady)
}
