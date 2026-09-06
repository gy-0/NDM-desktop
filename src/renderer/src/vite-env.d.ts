/// <reference types="vite/client" />

type EngineStatus = 'connecting' | 'live' | 'down'

type EngineStatusPayload = {
  status: EngineStatus
  engineError?: string
}

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
    readClipboardSnapshot?: () => Promise<{
      text: string
      changeCount: number
      selfWritten: boolean
    }>
    writeClipboard: (text: string) => Promise<void>
    exportCookies?: (targetURL: string, browser: string) => Promise<{ ok: boolean; header?: string; error?: string }>
    classifyURL?: (targetURL: string, browser?: string) => Promise<{ kind: 'binary' | 'html' | 'unknown'; contentType: string; disposition: string | null; contentLength: number | null; cookieUsed?: string; sessionNote?: string }>
    loadThumbnail: (url: string) => Promise<string | null>
    loadFileThumbnail: (filePath: string) => Promise<{
      dataURL: string
      kind: 'preview' | 'icon'
      installedPath?: string
    } | null>
    onEvent: (handler: (message: Record<string, unknown>) => void) => () => void
    onStatus: (handler: (payload: EngineStatusPayload) => void) => () => void
    getEngineError: () => Promise<string | null>
    retryEngine: () => Promise<EngineStatusPayload>
    onMenuAction: (handler: (action: string) => void) => () => void
    notifySnapshot?: (tasks: unknown[], baselineReady?: boolean) => void
    setWindowTheme?: (themeId: string) => void
    openTheme?: (id: string) => void
    openGallery?: () => void
  }
}