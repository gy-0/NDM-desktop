import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EngineClient } from './engine'

const THEME_BG: Record<string, string> = {
  walnut: '#141210',
  dawn: '#f4efe6',
  noon: '#f5f4f0',
  gallery: '#111110'
}

const engine = new EngineClient()

function rendererUrl(search: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}${search}`
  }
  const file = pathToFileURL(join(__dirname, '../renderer/index.html'))
  file.search = search.replace(/^\?/, '')
  return file.toString()
}

function createWindow(kind: 'gallery' | string): BrowserWindow {
  const gallery = kind === 'gallery'
  const work = screen.getPrimaryDisplay().workArea
  const width = gallery ? Math.min(1480, work.width - 40) : 1220
  const height = gallery ? Math.min(940, work.height - 40) : 780
  const window = new BrowserWindow({
    width,
    height,
    minWidth: gallery ? 1100 : 920,
    minHeight: 600,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    show: false,
    backgroundColor: THEME_BG[gallery ? 'gallery' : kind] ?? THEME_BG.walnut,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  window.loadURL(rendererUrl(gallery ? '?gallery=1' : `?theme=${kind}`))
  window.webContents.on('did-finish-load', () => {
    window.webContents.send('engine:status', engine.status)
  })
  return window
}

app.whenReady().then(() => {
  app.setName('NDM')
  engine.start()
  createWindow('walnut')

  ipcMain.handle('engine:request', async (_event, op: string, extra: Record<string, unknown> = {}) => {
    return engine.request(op, extra)
  })
  ipcMain.handle('engine:status', () => engine.status)

  ipcMain.on('ndm:open-theme', (_event, id: string) => {
    createWindow(id)
  })
  ipcMain.on('ndm:open-gallery', () => {
    const existing = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('gallery=1')
    )
    if (existing) {
      existing.focus()
      return
    }
    createWindow('gallery')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow('walnut')
  })
})

app.on('window-all-closed', () => {
  engine.stop()
  if (process.platform !== 'darwin') app.quit()
})
