import { app, dialog, safeStorage } from 'electron'
import { basename, isAbsolute, join } from 'node:path'
import { FileIntegrityService } from './fileIntegrity'
import { SettingsBackupService } from './settingsBackup'
import { DownloadImportService } from './downloadImport'
import { CompletionActionService } from './completionAction'
import { performCompletionAction } from './completionPower'
import type { SettingsBackupValues } from '../shared/settingsBackup'

type Request = (op: string, extra?: Record<string, unknown>) => Promise<unknown>

/** Main-process tools share the authoritative engine instead of a renderer snapshot. */
export function createDownloadTools(request: Request, updateSettings: (patch: SettingsBackupValues) => Promise<unknown>) {
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
      const result = await dialog.showSaveDialog({ title: '导出下载设置', defaultPath: 'NDM-settings.json', filters: [{ name: 'NDM 设置', extensions: ['json'] }] })
      return result.canceled ? null : result.filePath ?? null
    },
    chooseImportPath: async () => {
      const result = await dialog.showOpenDialog({ title: '导入下载设置', properties: ['openFile'], filters: [{ name: 'NDM 设置', extensions: ['json'] }] })
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
      const result = await dialog.showOpenDialog({ title: '导入下载任务', properties: ['openFile'], filters: [{ name: 'aria2 任务文件', extensions: ['txt', 'aria2', 'list'] }, { name: '所有文件', extensions: ['*'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    createDownload: async options => {
      const result = await request('add', options)
      return result
    }
  })
  return {
    supports: (op: string) => ['fileIntegrityStart', 'fileIntegrityStatus', 'fileIntegrityCancel', 'settingsBackupExport', 'settingsBackupPreview', 'settingsBackupApply', 'downloadImportPreview', 'downloadImportCreate', 'downloadImportResume', 'downloadImportStatus', 'completionActionStatus', 'completionActionArm', 'completionActionCancel'].includes(op),
    request: (op: string, extra: Record<string, unknown>) => {
      if (op.startsWith('fileIntegrity')) return integrity.handle(op, extra)
      if (op.startsWith('settingsBackup')) return backup.request(op, extra)
      if (op.startsWith('completionAction')) return completion.handle(op, extra)
      return importer.request(op, extra)
    },
    tasksChanged: () => { void completion.checkNow() },
    dispose: () => { integrity.dispose(); completion.dispose() }
  }
}
