/// <reference types="vite/client" />

type EngineStatus = 'connecting' | 'live' | 'down'

interface Window {
  ndm?: {
    platform: string
    version: string
    build?: string
    status: () => Promise<EngineStatus>
    request: (op: string, extra?: Record<string, unknown>) => Promise<unknown>
    selectFolder: (defaultPath?: string) => Promise<string | null>
    revealFile: (filePath: string) => Promise<boolean>
    openPath: (filePath: string) => Promise<string>
    shareFile: (filePath: string) => Promise<boolean>
    quickLook: (filePath: string) => Promise<boolean>
    openExternal: (url: string) => Promise<boolean>
    extensionPath?: () => Promise<string | null>
    readClipboard: () => Promise<string>
    writeClipboard: (text: string) => Promise<void>
    loadThumbnail: (url: string) => Promise<string | null>
    loadFileThumbnail: (filePath: string) => Promise<{
      dataURL: string
      kind: 'preview' | 'icon'
      installedPath?: string
    } | null>
    onEvent: (handler: (message: Record<string, unknown>) => void) => () => void
    onStatus: (handler: (status: EngineStatus) => void) => () => void
    onMenuAction: (handler: (action: string) => void) => () => void
    notifySnapshot?: (tasks: unknown[], baselineReady?: boolean) => void
    setWindowTheme?: (themeId: string) => void
    openTheme?: (id: string) => void
    openGallery?: () => void
  }
}
