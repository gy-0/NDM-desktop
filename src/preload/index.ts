import { contextBridge, ipcRenderer } from 'electron'
import packageJSON from '../../package.json'
import type { EngineStatus, EngineStatusPayload } from '../main/engine'

contextBridge.exposeInMainWorld('ndm', {
  platform: process.platform,
  version: packageJSON.version,
  build: packageJSON.buildNumber,
  status: async () => {
    // The invoke now returns a payload object; older builds returned a bare
    // string. Normalize here so the public API stays a plain status.
    const reply = await ipcRenderer.invoke('engine:status') as EngineStatusPayload | EngineStatus
    return typeof reply === 'string' ? reply : reply.status
  },
  request: (op: string, extra: Record<string, unknown> = {}) => ipcRenderer.invoke('engine:request', op, extra),
  selectFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:select-folder', defaultPath) as Promise<string | null>,
  revealFile: (filePath: string) => ipcRenderer.invoke('system:reveal-file', filePath) as Promise<boolean>,
  openPath: (filePath: string) => ipcRenderer.invoke('system:open-path', filePath) as Promise<string>,
  shareFile: (filePath: string) => ipcRenderer.invoke('system:share-file', filePath) as Promise<boolean>,
  quickLook: (filePath: string) => ipcRenderer.invoke('system:quick-look', filePath) as Promise<boolean>,
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url) as Promise<boolean>,
  extensionPath: () => ipcRenderer.invoke('system:extension-path') as Promise<string | null>,
  readClipboard: () => ipcRenderer.invoke('system:read-clipboard') as Promise<string>,
  readClipboardSnapshot: () =>
    ipcRenderer.invoke('system:clipboard-snapshot') as Promise<{
      text: string
      changeCount: number
      selfWritten: boolean
    }>,
  writeClipboard: (text: string) => ipcRenderer.invoke('system:write-clipboard', text) as Promise<void>,
  exportCookies: (targetURL: string, browser: string) =>
    ipcRenderer.invoke('system:export-cookies', targetURL, browser) as Promise<{ ok: boolean; header?: string; error?: string }>,
  classifyURL: (targetURL: string) =>
    ipcRenderer.invoke('system:classify-url', targetURL) as Promise<{ kind: 'binary' | 'html' | 'unknown'; contentType: string; disposition: string | null; contentLength: number | null; cookieUsed?: string }>,
  loadThumbnail: (url: string) => ipcRenderer.invoke('media:thumbnail', url) as Promise<string | null>,
  loadFileThumbnail: (filePath: string) => ipcRenderer.invoke('media:file-thumbnail', filePath) as Promise<{
    dataURL: string
    kind: 'preview' | 'icon'
    installedPath?: string
  } | null>,
  onEvent: (handler: (message: Record<string, unknown>) => void) => {
    const listen = (_event: unknown, message: Record<string, unknown>): void => handler(message)
    ipcRenderer.on('engine:event', listen)
    return () => ipcRenderer.removeListener('engine:event', listen)
  },
  onStatus: (handler: (payload: EngineStatusPayload) => void) => {
    const listen = (
      _event: unknown,
      payload: EngineStatusPayload | 'connecting' | 'live' | 'down'
    ): void => {
      // Backwards-compatible: older main-process builds pushed a bare status
      // string over this channel; normalize it into a payload object.
      if (typeof payload === 'string') {
        handler({ status: payload, engineError: undefined })
      } else {
        handler(payload)
      }
    }
    ipcRenderer.on('engine:status', listen)
    return () => ipcRenderer.removeListener('engine:status', listen)
  },
  getEngineError: () => ipcRenderer.invoke('engine:error') as Promise<string | null>,
  retryEngine: () => ipcRenderer.invoke('engine:retry') as Promise<EngineStatusPayload>,
  onMenuAction: (handler: (action: string) => void) => {
    const listen = (_event: unknown, action: string): void => handler(action)
    ipcRenderer.on('menu:action', listen)
    return () => ipcRenderer.removeListener('menu:action', listen)
  },
  notifySnapshot: (tasks: unknown[], baselineReady = false) =>
    ipcRenderer.send('engine:tasks-snapshot', tasks, baselineReady),
  setWindowTheme: (themeId: string) => ipcRenderer.send('window:set-theme', themeId),
  openTheme: (id: string) => ipcRenderer.send('ndm:open-theme', id),
  openGallery: () => ipcRenderer.send('ndm:open-gallery')
})