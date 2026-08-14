import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
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

function createMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 NDM' },
              { type: 'separator' },
              {
                label: '偏好设置...',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  const focused = BrowserWindow.getFocusedWindow()
                  focused?.webContents.send('menu:action', 'open-settings')
                }
              },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 NDM' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出 NDM' }
            ]
          } as Electron.MenuItemConstructorOptions
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建下载...',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow()
            focused?.webContents.send('menu:action', 'new-download')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '搜索下载',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow()
            focused?.webContents.send('menu:action', 'focus-search')
          }
        },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏幕' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' }
            ]
          : [])
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

let prevTaskStates = new Map<number, string>()

app.whenReady().then(() => {
  app.setName('NDM')
  createMenu()
  engine.start()
  const mainWindow = createWindow('walnut')

  ipcMain.handle('engine:request', async (_event, op: string, extra: Record<string, unknown> = {}) => {
    return engine.request(op, extra)
  })
  ipcMain.handle('engine:status', () => engine.status)

  ipcMain.handle('dialog:select-folder', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: '选择下载目录',
      defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('system:reveal-file', async (_event, filePath: string) => {
    if (!filePath) return false
    if (existsSync(filePath)) {
      shell.showItemInFolder(filePath)
      return true
    }
    // If exact file doesn't exist, open its directory
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    if (dir && existsSync(dir)) {
      shell.openPath(dir)
      return true
    }
    return false
  })

  ipcMain.handle('system:open-path', async (_event, filePath: string) => {
    if (!filePath) return '路径为空'
    if (existsSync(filePath)) {
      return shell.openPath(filePath)
    }
    return '文件不存在'
  })

  ipcMain.handle('system:read-clipboard', () => {
    return clipboard.readText()
  })

  ipcMain.handle('system:write-clipboard', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('system:quick-look', async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false
    spawn('qlmanage', ['-p', filePath], { stdio: 'ignore', detached: true }).unref()
    return true
  })

  ipcMain.handle('system:open-path', async (_event, targetPath: string) => {
    if (!targetPath) return ''
    return shell.openPath(targetPath)
  })

  ipcMain.handle('system:open-external', async (_event, url: string) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

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

  // Listen to engine events for notifications & dock badge
  // Hook renderer IPC or engine broadcasts
  ipcMain.on('engine:tasks-snapshot', (_event, tasks: Array<{ id: number; title: string; filename: string; status: string; folderPath: string }>) => {
    if (!Array.isArray(tasks)) return

    let activeCount = 0
    for (const t of tasks) {
      if (t.status === 'downloading') activeCount++

      const prev = prevTaskStates.get(t.id)
      if (prev === 'downloading' && t.status === 'complete') {
        const fullPath = t.folderPath ? (t.folderPath.endsWith('/') ? `${t.folderPath}${t.filename}` : `${t.folderPath}/${t.filename}`) : t.filename
        const notif = new Notification({
          title: '下载已完成',
          body: t.title || t.filename,
          silent: false
        })
        notif.on('click', () => {
          if (existsSync(fullPath)) shell.showItemInFolder(fullPath)
          else mainWindow.show()
        })
        notif.show()
      } else if (prev === 'downloading' && t.status === 'error') {
        new Notification({
          title: '下载失败',
          body: `${t.title || t.filename} 下载遇到错误`,
          silent: true
        }).show()
      }
      prevTaskStates.set(t.id, t.status)
    }

    if (process.platform === 'darwin') {
      app.dock.setBadge(activeCount > 0 ? String(activeCount) : '')
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow('walnut')
  })
})

app.on('window-all-closed', () => {
  engine.stop()
  if (process.platform !== 'darwin') app.quit()
})

