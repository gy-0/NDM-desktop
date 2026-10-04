type Message = Record<string, unknown>
type Listener = (message: Message) => void
type EventSource = {
  onEvent: (listener: Listener) => () => void
  onEventJSON?: (listener: (message: string) => void) => () => void
}

// One isolated-world crossing and one parse per event, shared by the store,
// thumbnails, composer and other UI consumers. Unmounting the last consumer
// releases the preload subscription, including during React StrictMode replay.
export function createEngineEvents(source: EventSource): (listener: Listener) => () => void {
  const listeners = new Set<Listener>()
  let stop: (() => void) | undefined
  const deliver = (message: Message): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try { listener(message) } catch (error) {
        // One view must not prevent the task store or other views receiving it.
        queueMicrotask(() => { throw error })
      }
    }
  }
  return (listener) => {
    listeners.add(listener)
    if (!stop) {
      stop = source.onEventJSON
        ? source.onEventJSON((text) => {
          let message: unknown
          try { message = JSON.parse(text) } catch { return }
          if (message && typeof message === 'object' && !Array.isArray(message)) deliver(message as Message)
        })
        : source.onEvent(deliver)
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) { stop?.(); stop = undefined }
    }
  }
}

const subscriptions = new WeakMap<EventSource, ReturnType<typeof createEngineEvents>>()
export function subscribeEngineEvents(listener: Listener): () => void {
  const source = window.ndm
  if (!source) return () => {}
  let subscribe = subscriptions.get(source)
  if (!subscribe) { subscribe = createEngineEvents(source); subscriptions.set(source, subscribe) }
  return subscribe(listener)
}
