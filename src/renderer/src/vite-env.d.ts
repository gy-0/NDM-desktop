/// <reference types="vite/client" />

type EngineStatus = 'connecting' | 'live' | 'down'

interface Window {
  ndm?: {
    platform: string
    version: string
    status: () => Promise<EngineStatus>
    request: (op: string, extra?: Record<string, unknown>) => Promise<unknown>
    selectFolder: (defaultPath?: string) => Promise<string | null>
    revealFile: (filePath: string) => Promise<boolean>
    openPath: (filePath: string) => Promise<string>
    quickLook: (filePath: string) => Promise<boolean>
    openExternal: (url: string) => Promise<boolean>
    extensionPath?: () => Promise<string | null>
    readClipboard: () => Promise<string>
    writeClipboard: (text: string) => Promise<void>
    loadThumbnail: (url: string) => Promise<string | null>
    loadFileThumbnail: (filePath: string) => Promise<string | null>
    onEvent: (handler: (message: Record<string, unknown>) => void) => () => void
    onStatus: (handler: (status: EngineStatus) => void) => () => void
    onMenuAction: (handler: (action: string) => void) => () => void
    notifySnapshot?: (tasks: unknown[]) => void
    openTheme?: (id: string) => void
    openGallery?: () => void
  }
}
