import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ndm', {
  platform: process.platform,
  version: '2026.8.15',
  status: () => ipcRenderer.invoke('engine:status') as Promise<'connecting' | 'live' | 'down'>,
  request: (op: string, extra: Record<string, unknown> = {}) => ipcRenderer.invoke('engine:request', op, extra),
  selectFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:select-folder', defaultPath) as Promise<string | null>,
  revealFile: (filePath: string) => ipcRenderer.invoke('system:reveal-file', filePath) as Promise<boolean>,
  openPath: (filePath: string) => ipcRenderer.invoke('system:open-path', filePath) as Promise<string>,
  quickLook: (filePath: string) => ipcRenderer.invoke('system:quick-look', filePath) as Promise<boolean>,
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url) as Promise<boolean>,
  extensionPath: () => ipcRenderer.invoke('system:extension-path') as Promise<string | null>,
  readClipboard: () => ipcRenderer.invoke('system:read-clipboard') as Promise<string>,
  writeClipboard: (text: string) => ipcRenderer.invoke('system:write-clipboard', text) as Promise<void>,
  loadThumbnail: (url: string) => ipcRenderer.invoke('media:thumbnail', url) as Promise<string | null>,
  loadFileThumbnail: (filePath: string) => ipcRenderer.invoke('media:file-thumbnail', filePath) as Promise<string | null>,
  onEvent: (handler: (message: Record<string, unknown>) => void) => {
    const listen = (_event: unknown, message: Record<string, unknown>): void => handler(message)
    ipcRenderer.on('engine:event', listen)
    return () => ipcRenderer.removeListener('engine:event', listen)
  },
  onStatus: (handler: (status: 'connecting' | 'live' | 'down') => void) => {
    const listen = (_event: unknown, status: 'connecting' | 'live' | 'down'): void => handler(status)
    ipcRenderer.on('engine:status', listen)
    return () => ipcRenderer.removeListener('engine:status', listen)
  },
  onMenuAction: (handler: (action: string) => void) => {
    const listen = (_event: unknown, action: string): void => handler(action)
    ipcRenderer.on('menu:action', listen)
    return () => ipcRenderer.removeListener('menu:action', listen)
  },
  notifySnapshot: (tasks: unknown[]) => ipcRenderer.send('engine:tasks-snapshot', tasks),
  openTheme: (id: string) => ipcRenderer.send('ndm:open-theme', id),
  openGallery: () => ipcRenderer.send('ndm:open-gallery')
})
