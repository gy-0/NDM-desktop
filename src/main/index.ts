import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { EngineClient } from './engine'

const THEME_BG: Record<string, string> = {
  walnut: '#141210',
  dawn: '#f4efe6',
  noon: '#f5f4f0',
  gallery: '#111110'
}

const engine = new EngineClient()

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  } else {
    createWindow('main')
  }
})

function rendererUrl(search: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}${search}`
  }
  const file = pathToFileURL(join(__dirname, '../renderer/index.html'))
  file.search = search.replace(/^\?/, '')
  return file.toString()
}

function createWindow(kind: 'main' | 'gallery' | string): BrowserWindow {
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
    acceptFirstMouse: true,
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
  window.loadURL(rendererUrl(gallery ? '?gallery=1' : kind === 'main' ? '' : `?theme=${kind}`))
  window.webContents.on('did-finish-load', () => {
    window.webContents.send('engine:status', engine.status)
  })
  return window
}

function sendMenuAction(action: string): void {
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  focused?.webContents.send('menu:action', action)
}

function createMenu(): void {
  const isMac = process.platform === 'darwin'

  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: '关于 NDM' },
      { type: 'separator' },
      {
        label: '偏好设置...',
        accelerator: 'CmdOrCtrl+,',
        click: () => sendMenuAction('open-settings')
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
  }

  // Reload / DevTools stay out of release builds so ⌘R can mean
  // "reveal in Finder" inside the app, matching the advertised shortcut.
  const devItems: Electron.MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建下载...',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-download')
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
      label: '任务',
      submenu: [
        {
          label: '全部暂停',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => void engine.request('pauseAll').catch(() => undefined)
        },
        {
          label: '全部继续',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => void engine.request('resumeAll').catch(() => undefined)
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '搜索下载',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuAction('focus-search')
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏幕' },
        ...devItems
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] as Electron.MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

type SnapshotTask = {
  id: number
  title: string
  filename: string
  status: string
  folderPath: string
  fileSize: number
  completedBytes: number
}

let prevTaskStates = new Map<number, string>()
let hasInitialTaskSnapshot = false

app.whenReady().then(() => {
  app.setName('NDM')
  createMenu()
  engine.start()
  createWindow('main')

  ipcMain.handle('engine:request', async (_event, op: string, extra: Record<string, unknown> = {}) => {
    try {
      return await engine.request(op, extra)
    } catch (error) {
      if (op === 'probeMedia') {
        const requestError = error as Error & { code?: string }
        return {
          ok: false,
          error: requestError.message,
          errorKind: requestError.code ?? 'probeFailed'
        }
      }
      throw error
    }
  })
  ipcMain.handle('engine:status', () => engine.status)

  ipcMain.handle('dialog:select-folder', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择下载目录',
      defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
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

  ipcMain.handle('system:open-path', async (_event, targetPath: string) => {
    if (!targetPath) return '路径为空'
    if (existsSync(targetPath)) {
      return shell.openPath(targetPath)
    }
    return '文件不存在'
  })

  ipcMain.handle('system:read-clipboard', () => {
    return clipboard.readText()
  })

  ipcMain.handle('system:write-clipboard', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('media:thumbnail', async (_event, rawURL: string) => {
    let url: URL
    try {
      url = new URL(rawURL)
    } catch {
      return null
    }
    if (url.protocol !== 'https:') return null
    const response = await net.fetch(url.toString(), { redirect: 'follow' })
    if (!response.ok) return null
    const mime = response.headers.get('content-type')?.split(';')[0] ?? ''
    if (!mime.startsWith('image/')) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  })

  ipcMain.handle('system:quick-look', async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false
    spawn('qlmanage', ['-p', filePath], { stdio: 'ignore', detached: true }).unref()
    return true
  })

  ipcMain.handle('system:open-external', async (_event, url: string) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  ipcMain.handle('system:extension-path', () => {
    const packaged = join(process.resourcesPath, 'extension/NDMRelay')
    if (existsSync(packaged)) return packaged
    const source = join(process.env.NDM_SOURCE ?? join(homedir(), 'NDM'), 'extension/NDMRelay')
    if (existsSync(source)) return source
    return null
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

  // Snapshot relay from renderer: completion notifications, dock badge & progress.
  ipcMain.on('engine:tasks-snapshot', (_event, tasks: SnapshotTask[]) => {
    if (!Array.isArray(tasks)) return

    let activeCount = 0
    let totalBytes = 0
    let doneBytes = 0
    const nextStates = new Map<number, string>()
    let shouldSurfaceWindow = false

    for (const t of tasks) {
      if (t.status === 'downloading') {
        activeCount++
        if (t.fileSize > 0) {
          totalBytes += t.fileSize
          doneBytes += Math.min(t.completedBytes, t.fileSize)
        }
      }

      const prev = prevTaskStates.get(t.id)
      const isNewUserTask = hasInitialTaskSnapshot && prev === undefined &&
        (t.status === 'downloading' || t.status === 'waiting' || t.status === 'complete')
      if (isNewUserTask) shouldSurfaceWindow = true
      if ((prev === 'downloading' || (hasInitialTaskSnapshot && prev === undefined)) && t.status === 'complete') {
        shouldSurfaceWindow = true
        const fullPath = t.folderPath
          ? t.folderPath.endsWith('/')
            ? `${t.folderPath}${t.filename}`
            : `${t.folderPath}/${t.filename}`
          : t.filename
        const notif = new Notification({
          title: '下载已完成',
          subtitle: t.title && t.title !== t.filename ? t.title : undefined,
          body: t.filename,
          silent: false
        })
        notif.on('click', () => {
          if (existsSync(fullPath)) {
            shell.showItemInFolder(fullPath)
          } else {
            const window = BrowserWindow.getAllWindows()[0]
            if (window) {
              window.show()
              window.focus()
            } else {
              createWindow('main')
            }
          }
        })
        notif.show()
        const window = BrowserWindow.getAllWindows()[0]
        window?.webContents.send('engine:event', {
          op: 'downloadCompleted',
          task: {
            id: t.id,
            title: t.title,
            filename: t.filename,
            folderPath: t.folderPath,
            fullPath
          }
        })
      } else if (prev === 'downloading' && t.status === 'error') {
        new Notification({
          title: '下载失败',
          body: `${t.title || t.filename} 下载遇到错误`,
          silent: true
        }).show()
      }
      nextStates.set(t.id, t.status)
    }
    prevTaskStates = nextStates
    hasInitialTaskSnapshot = true

    if (process.platform === 'darwin') {
      app.dock?.setBadge(activeCount > 0 ? String(activeCount) : '')
    }
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.setProgressBar(activeCount > 0 && totalBytes > 0 ? Math.min(1, doneBytes / totalBytes) : -1)
      if (shouldSurfaceWindow && !window.isFocused()) {
        if (window.isMinimized()) window.restore()
        window.show()
        app.dock?.bounce('informational')
        app.focus({ steal: true })
        window.focus()
      }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow('main')
  })
})

// On macOS the app (and the download engine) keeps running with all
// windows closed — reopening from the Dock reconnects instantly.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  engine.stop()
})
