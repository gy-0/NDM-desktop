import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, screen, ShareMenu, shell, Tray } from 'electron'

// WebGPU drives NDM's transfer, drop and completion surfaces. Some Electron
// builds still gate it, so opt in before app ready and retain CSS fallbacks.
app.commandLine.appendSwitch('enable-unsafe-webgpu')
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { EngineClient } from './engine'

const THEME_BG: Record<string, string> = {
  walnut: '#101114',
  dawn: '#f1f1ef',
  noon: '#f5f6f7',
  gallery: '#101114'
}

const THEME_SYMBOL: Record<string, string> = {
  walnut: '#f5f5f7',
  dawn: '#1c1d20',
  noon: '#181a1e',
  gallery: '#f5f5f7'
}

const APP_PROTOCOL = 'ndm'
const engine = new EngineClient(showMainWindow)
const activeInstallPaths = new Set<string>()

type InstallDMGReply = {
  ok?: boolean
  outcome?: 'installed' | 'needsReplaceConsent' | 'needsLicenseHandoff' | 'needsAppChoice' | 'noAppFound'
  appName?: string
  installedPath?: string
  candidates?: string[]
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  showMainWindow()
})

app.on('open-url', (event, url) => {
  if (!url.toLowerCase().startsWith(`${APP_PROTOCOL}://`)) return
  event.preventDefault()
  if (app.isReady()) showMainWindow()
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
  const isMac = process.platform === 'darwin'
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
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: THEME_BG[gallery ? 'gallery' : kind] ?? THEME_BG.walnut,
            symbolColor: THEME_SYMBOL[gallery ? 'gallery' : kind] ?? THEME_SYMBOL.walnut,
            height: 52
          }
        }),
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
  bytesPerSecond?: number
}

let tray: Tray | null = null
let latestTrayTasks: SnapshotTask[] = []

function formatTraySpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function showMainWindow(): void {
  const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('gallery=1'))
    ?? BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }
  createWindow('main')
}

async function showOwnedMessageBox(
  owner: BrowserWindow | null,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
}

function sendInstallProgress(
  owner: BrowserWindow | null,
  path: string,
  phase: string,
  detail?: string,
  appName?: string,
  installedPath?: string
): void {
  const message: Record<string, unknown> = { op: 'installProgress', path, phase }
  if (detail) message.detail = detail
  if (appName) message.appName = appName
  if (installedPath) message.installedPath = installedPath
  if (owner && !owner.isDestroyed()) owner.webContents.send('engine:event', message)
  else {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('engine:event', message)
    }
  }
}

/**
 * Reuse NDMEngine's proven InstallerRunner and keep the human decisions in
 * native macOS dialogs. Each decision re-drives the same install request, so
 * the mount is always detached before the shell waits for the user's answer.
 */
async function installDiskImage(owner: BrowserWindow | null, targetPath: string): Promise<string> {
  const request: Record<string, unknown> = { path: targetPath }

  for (let step = 0; step < 5; step += 1) {
    let reply: InstallDMGReply
    try {
      reply = await engine.request('installDMG', request) as InstallDMGReply
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法安装这个磁盘映像'
      sendInstallProgress(owner, targetPath, 'failed', message)
      await showOwnedMessageBox(owner, {
        type: 'error',
        title: '安装失败',
        message: 'NDM 没能完成安装',
        detail: message,
        buttons: ['好']
      })
      return message
    }

    if (reply.outcome === 'installed' && reply.installedPath) {
      sendInstallProgress(owner, targetPath, 'complete', '应用已经可以使用', reply.appName, reply.installedPath)
      shell.showItemInFolder(reply.installedPath)
      return ''
    }

    if (reply.outcome === 'needsAppChoice' && reply.candidates?.length) {
      sendInstallProgress(owner, targetPath, 'waiting', '请选择要安装的应用')
      const candidates = reply.candidates.slice(0, 8)
      const cancelId = candidates.length
      const choice = await showOwnedMessageBox(owner, {
        type: 'question',
        title: '选择要安装的应用',
        message: '这个磁盘映像里有多个应用',
        detail: '请选择要复制到“应用程序”文件夹的应用。',
        buttons: [...candidates.map((name) => name.replace(/\.app$/i, '')), '取消'],
        defaultId: 0,
        cancelId
      })
      if (choice.response === cancelId) {
        sendInstallProgress(owner, targetPath, 'cancelled', '没有复制任何应用')
        return ''
      }
      request.selectedApp = candidates[choice.response]
      continue
    }

    if (reply.outcome === 'needsReplaceConsent') {
      const appName = reply.appName ?? '这个应用'
      sendInstallProgress(owner, targetPath, 'waiting', '应用程序中已有同名应用', appName)
      const decision = await showOwnedMessageBox(owner, {
        type: 'warning',
        title: `替换 ${appName.replace(/\.app$/i, '')}？`,
        message: '“应用程序”文件夹中已经有同名应用。',
        detail: '替换后，原来的应用版本会被新下载的版本覆盖。',
        buttons: ['取消', '替换'],
        defaultId: 1,
        cancelId: 0
      })
      if (decision.response !== 1) {
        sendInstallProgress(owner, targetPath, 'cancelled', '保留了原来的应用', appName)
        return ''
      }
      request.replaceExisting = true
      continue
    }

    if (reply.outcome === 'needsLicenseHandoff') {
      sendInstallProgress(owner, targetPath, 'waiting', '请先确认软件许可协议')
      const decision = await showOwnedMessageBox(owner, {
        type: 'warning',
        title: '软件许可协议',
        message: '这个磁盘映像包含软件许可协议。',
        detail: '你可以先查看原始协议，或接受协议后让 NDM 继续安装。',
        buttons: ['取消', '查看协议', '接受并安装'],
        defaultId: 2,
        cancelId: 0
      })
      if (decision.response === 1) {
        sendInstallProgress(owner, targetPath, 'cancelled', '已打开原始磁盘映像')
        return shell.openPath(targetPath)
      }
      if (decision.response !== 2) {
        sendInstallProgress(owner, targetPath, 'cancelled', '没有接受软件许可协议')
        return ''
      }
      request.licenseAccepted = true
      continue
    }

    // Images without an app bundle still belong to Disk Image Mounter.
    if (reply.outcome === 'noAppFound') {
      const detail = '映像内没有可安装的应用，已交给系统打开'
      sendInstallProgress(owner, targetPath, 'failed', detail)
      return shell.openPath(targetPath)
    }
    break
  }

  sendInstallProgress(owner, targetPath, 'failed', '安装流程未完成')
  return '安装流程未完成'
}

function trayIcon(): Electron.NativeImage {
  const packaged = process.platform === 'darwin'
    ? join(process.resourcesPath, 'icon.icns')
    : join(process.resourcesPath, 'assets', 'ndm-icon.png')
  const source = process.platform === 'darwin'
    ? join(process.env.NDM_SOURCE ?? join(homedir(), 'NDM'), 'Sources/NDMApp/Resources/Brand/NDM.icns')
    : join(process.cwd(), 'build', 'ndm-icon.png')
  const path = existsSync(packaged) ? packaged : source
  const image = nativeImage.createFromPath(path).resize({ width: 18, height: 18 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function refreshTray(): void {
  if (!tray) return
  const active = latestTrayTasks.filter((task) => task.status === 'downloading')
  const paused = latestTrayTasks.filter((task) => task.status === 'paused' || task.status === 'incomplete')
  const speed = active.reduce((sum, task) => sum + (task.bytesPerSecond ?? 0), 0)
  const recent = [...latestTrayTasks]
    .filter((task) => task.status !== 'complete')
    .slice(0, 5)
  // Per-task resume from the tray: picking WHICH stale task to revive is the
  // common intent, and granular clicks are inherently safer than a blind
  // resume-all on a library with thousands of parked rows.
  const pausedItems: Electron.MenuItemConstructorOptions[] = paused.slice(0, 8).map((task) => ({
    label: `· ${(task.title || task.filename).slice(0, 42)}`,
    click: () => void engine.request('resume', { taskID: task.id }).catch(() => undefined)
  }))
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: active.length > 0 ? `正在下载 ${active.length} 项 · ${formatTraySpeed(speed)}` : '当前没有进行中的下载',
      enabled: false
    },
    { type: 'separator' },
    ...recent.map((task) => ({
      label: `${task.status === 'downloading' ? '↓ ' : ''}${task.title || task.filename}`.slice(0, 42),
      click: () => showMainWindow()
    })),
    ...(recent.length > 0 ? [{ type: 'separator' } as const] : []),
    {
      label: '全部暂停',
      enabled: active.length > 0,
      click: () => void engine.request('pauseAll').catch(() => undefined)
    },
    ...(paused.length > 0 ? [{
      label: `已暂停 (${paused.length})`,
      submenu: [
        ...pausedItems,
        ...(paused.length > 8 ? [{ type: 'separator' } as const, { label: `…以及另外 ${paused.length - 8} 项`, enabled: false }] : []),
        { type: 'separator' } as const,
        {
          label: `全部继续（${paused.length} 项）`,
          click: () => void engine.request('resumeAll').catch(() => undefined)
        }
      ]
    }] : []),
    { label: '打开 NDM', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 NDM', click: () => app.quit() }
  ]
  tray.setToolTip(active.length > 0 ? `NDM · ${formatTraySpeed(speed)}` : 'NDM')
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

let prevTaskStates = new Map<number, string>()
let hasInitialTaskSnapshot = false

app.whenReady().then(() => {
  app.setName('NDM')
  app.setAsDefaultProtocolClient(APP_PROTOCOL)
  createMenu()
  tray = new Tray(trayIcon())
  tray.on('click', () => showMainWindow())
  refreshTray()
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
    const dir = dirname(filePath)
    if (dir && existsSync(dir)) {
      shell.openPath(dir)
      return true
    }
    return false
  })

  ipcMain.handle('system:open-path', async (event, targetPath: string) => {
    if (!targetPath) return '路径为空'
    if (existsSync(targetPath)) {
      if (process.platform === 'darwin' && targetPath.toLowerCase().endsWith('.dmg')) {
        const owner = BrowserWindow.fromWebContents(event.sender)
        if (activeInstallPaths.has(targetPath)) {
          sendInstallProgress(owner, targetPath, 'preparing', '这个安装已经在进行中')
          return ''
        }
        activeInstallPaths.add(targetPath)
        sendInstallProgress(owner, targetPath, 'preparing')
        try {
          return await installDiskImage(owner, targetPath)
        } finally {
          activeInstallPaths.delete(targetPath)
        }
      }
      return shell.openPath(targetPath)
    }
    return '文件不存在'
  })

  ipcMain.handle('system:share-file', async (event, filePath: string) => {
    if (process.platform !== 'darwin' || !filePath || !existsSync(filePath)) return false
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    new ShareMenu({ filePaths: [filePath] }).popup({ window })
    return true
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

  ipcMain.handle('media:file-thumbnail', async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return null
    try {
      const image = await nativeImage.createThumbnailFromPath(filePath, { width: 640, height: 360 })
      return image.isEmpty() ? null : image.toDataURL()
    } catch {
      return null
    }
  })

  ipcMain.handle('system:quick-look', async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false
    if (process.platform === 'win32') {
      await shell.openPath(filePath)
      return true
    }
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
    if (process.platform === 'win32') return null
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
  ipcMain.on('window:set-theme', (event, themeId: string) => {
    if (process.platform !== 'win32') return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return
    window.setTitleBarOverlay({
      color: THEME_BG[themeId] ?? THEME_BG.walnut,
      symbolColor: THEME_SYMBOL[themeId] ?? THEME_SYMBOL.walnut,
      height: 52
    })
  })

  // Snapshot relay from renderer: completion notifications, dock badge & progress.
  // `baselineReady` is false until the renderer has received a full snapshot —
  // a partial-only view must never become the notification baseline, or every
  // historical completed task would fire as "just finished" when the full
  // library arrives moments later.
  ipcMain.on('engine:tasks-snapshot', (_event, tasks: SnapshotTask[], baselineReady = false) => {
    if (!Array.isArray(tasks)) return
    latestTrayTasks = tasks
    refreshTray()

    let activeCount = 0
    let totalBytes = 0
    let doneBytes = 0
    const nextStates = new Map<number, string>()

    for (const t of tasks) {
      if (t.status === 'downloading') {
        activeCount++
        if (t.fileSize > 0) {
          totalBytes += t.fileSize
          doneBytes += Math.min(t.completedBytes, t.fileSize)
        }
      }

      if (!baselineReady) continue

      const prev = prevTaskStates.get(t.id)
      if ((prev === 'downloading' || (hasInitialTaskSnapshot && prev === undefined)) && t.status === 'complete') {
        const fullPath = t.folderPath ? join(t.folderPath, t.filename) : t.filename
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
        // Quiet by design: notification, dock bounce and the in-app completion
        // bar. Never steal focus from whatever the user is doing.
        app.dock?.bounce('informational')
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
    if (baselineReady) {
      prevTaskStates = nextStates
      hasInitialTaskSnapshot = true
    }

    if (process.platform === 'darwin') {
      app.dock?.setBadge(activeCount > 0 ? String(activeCount) : '')
    }
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.setProgressBar(activeCount > 0 && totalBytes > 0 ? Math.min(1, doneBytes / totalBytes) : -1)
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
