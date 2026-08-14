import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ndm', {
  platform: process.platform,
  version: '2026.8.14',
  status: () => ipcRenderer.invoke('engine:status') as Promise<'connecting' | 'live' | 'down'>,
  request: (op: string, extra: Record<string, unknown> = {}) => ipcRenderer.invoke('engine:request', op, extra),
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
  openTheme: (id: string) => ipcRenderer.send('ndm:open-theme', id),
  openGallery: () => ipcRenderer.send('ndm:open-gallery')
})
