/// <reference types="vite/client" />

type EngineStatus = 'connecting' | 'live' | 'down'

interface Window {
  ndm?: {
    platform: string
    version: string
    status: () => Promise<EngineStatus>
    request: (op: string, extra?: Record<string, unknown>) => Promise<unknown>
    onEvent: (handler: (message: Record<string, unknown>) => void) => () => void
    onStatus: (handler: (status: EngineStatus) => void) => () => void
    openTheme?: (id: string) => void
    openGallery?: () => void
  }
}
