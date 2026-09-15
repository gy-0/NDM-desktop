import { app, dialog, safeStorage } from 'electron'
import type { BrowserWindow } from 'electron'
import { basename, isAbsolute, join } from 'node:path'
import { FileIntegrityService } from './fileIntegrity'
import { SettingsBackupService } from './settingsBackup'
import { DownloadImportService } from './downloadImport'
import { CompletionActionService } from './completionAction'
import { performCompletionAction } from './completionPower'
import { DirectoryRulesService } from './directoryRules'
import { AuxiliaryToolsService } from './auxiliaryTools'
import { BTTransferControlsService } from './btTransferControls'
import { createNativePicker, type NativePickerDialogs } from './nativePicker'
import type { SettingsBackupValues } from '../shared/settingsBackup'

type Request = (op: string, extra?: Record<string, unknown>) => Promise<unknown>

/** Main-process tools share the authoritative engine instead of a renderer snapshot. */
export function createDownloadTools(request: Request, updateSettings: (patch: SettingsBackupValues) => Promise<unknown>, dialogs: NativePickerDialogs = dialog) {
  const picker = createNativePicker(dialogs)
  const btControls = new BTTransferControlsService({ request })
  const auxiliary = new AuxiliaryToolsService({ request,
    chooseTorrent: async () => {
      const result = await picker.open({ title: '选择种子文件', properties: ['openFile'], filters: [{ name: 'BitTorrent 种子', extensions: ['torrent'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  })
  const directories = new DirectoryRulesService({
    // Native DownloadStore uses dev.ndm.open, distinct from Electron userData.
    // An isolated QA override must cover both processes without hiding that
    // distinction in normal installed-app runs.
    statePath: join(process.env.NDM_SUPPORT_DIR || (process.platform === 'darwin'
      ? join(app.getPath('appData'), 'dev.ndm.open') : app.getPath('userData')), 'directory-rules.json'),
    chooseDirectory: async () => {
      const result = await picker.open({ title: '选择规则的下载目录', properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    resolveFallbackDirectory: async sample => {
      const reply = await request('directoryRulesFallback', { url: sample.url, filename: sample.filename }) as { ok?: boolean; directory?: string }
      if (!reply.ok || typeof reply.directory !== 'string') throw new Error('未能读取默认下载目录。')
      return reply.directory
    },
    applyConfig: async () => {
      const reply = await request('directoryRulesReload') as { ok?: boolean }
      if (!reply.ok) throw new Error('下载引擎未确认目录规则。')
    }
  })
  const completion = new CompletionActionService({
    listTasks: async () => {
      const reply = await request('list') as { ok?: boolean; tasks?: Array<{ id: number; status: string; isLiveRecording?: boolean }> }
      if (!reply.ok || !Array.isArray(reply.tasks)) throw new Error('未能确认下载状态。')
      return reply.tasks.map(task => ({ id: task.id, status: task.status,
        isLiveRecording: task.isLiveRecording === true && task.status !== 'complete' }))
    },
    perform: performCompletionAction
  })
  const integrity = new FileIntegrityService({
    resolveTask: async taskID => {
      const reply = await request('list') as { ok?: boolean; tasks?: Array<Record<string, unknown>> }
      if (!reply.ok || !Array.isArray(reply.tasks)) throw new Error('未能读取下载任务。')
      const task = reply.tasks.find(task => task.id === taskID)
      if (!task) return null
      if (typeof task.folderPath !== 'string' || !isAbsolute(task.folderPath)
          || typeof task.filename !== 'string' || !task.filename || basename(task.filename) !== task.filename) {
        throw new Error('该任务没有有效的成品路径。')
      }
      return { id: taskID, status: String(task.status), path: join(task.folderPath, task.filename) }
    }
  })
  const backup = new SettingsBackupService({
    appVersion: app.getVersion(),
    getSettings: async () => {
      const reply = await request('getSettings') as { ok?: boolean; settings?: Record<string, unknown> }
      if (!reply.ok || !reply.settings) throw new Error('未能读取下载设置。')
      return reply.settings
    },
    updateSettings,
    chooseExportPath: async () => {
      const result = await picker.save({ title: '导出下载设置', defaultPath: 'NDM-settings.json', filters: [{ name: 'NDM 设置', extensions: ['json'] }] })
      return result.canceled ? null : result.filePath ?? null
    },
    chooseImportPath: async () => {
      const result = await picker.open({ title: '导入下载设置', properties: ['openFile'], filters: [{ name: 'NDM 设置', extensions: ['json'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  })
  const importer = new DownloadImportService({
    statePath: join(process.env.NDM_SUPPORT_DIR || app.getPath('userData'), 'download-import.enc'),
    cipher: {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptString: value => safeStorage.encryptStringAsync(value),
      decryptString: async value => (await safeStorage.decryptStringAsync(value)).result,
      ...(process.platform === 'linux' ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {})
    },
    getCreationReceipt: creationKey => request('getCreationReceipt', { creationKey }),
    selectFile: async () => {
      const result = await picker.open({ title: '导入下载任务', properties: ['openFile'], filters: [{ name: 'aria2 任务文件', extensions: ['txt', 'aria2', 'list'] }, { name: '所有文件', extensions: ['*'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    createDownload: async options => {
      const result = await request('add', options)
      return result
    }
  })
  return {
    supports: (op: string) => btControls.supports(op) || auxiliary.supports(op) || ['fileIntegrityStart', 'fileIntegrityStatus', 'fileIntegrityCancel', 'settingsBackupExport', 'settingsBackupPreview', 'settingsBackupApply', 'downloadImportPreview', 'downloadImportCreate', 'downloadImportResume', 'downloadImportStatus', 'completionActionStatus', 'completionActionArm', 'completionActionCancel', 'directoryRulesGet', 'directoryRulesSave', 'directoryRulesChooseDirectory', 'directoryRulesPreview', 'directoryRulesResolve'].includes(op),
    request: (op: string, extra: Record<string, unknown>, owner?: BrowserWindow | null) => picker.run(owner, async () => {
      if (btControls.supports(op)) return btControls.request(op, extra)
      if (auxiliary.supports(op)) return auxiliary.request(op, extra)
      if (op.startsWith('fileIntegrity')) return integrity.handle(op, extra)
      if (op.startsWith('settingsBackup')) return backup.request(op, extra)
      if (op.startsWith('completionAction')) return completion.handle(op, extra)
      if (op.startsWith('directoryRules')) return directories.request(op, extra)
      return importer.request(op, extra)
    }),
    tasksChanged: () => { void completion.checkNow() },
    dispose: () => { integrity.dispose(); completion.dispose(); auxiliary.dispose() }
  }
}
