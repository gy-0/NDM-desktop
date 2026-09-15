import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron'

export interface NativePickerDialogs {
  showOpenDialog(owner: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showSaveDialog(owner: BrowserWindow, options: SaveDialogOptions): Promise<SaveDialogReturnValue>
}

/** Preserve the requesting window through service queues and asynchronous work.
 * On macOS a parent makes the picker a sheet in that window's fullscreen Space. */
export function createNativePicker(dialogs: NativePickerDialogs) {
  const owners = new AsyncLocalStorage<BrowserWindow | null>()
  return {
    run<T>(owner: BrowserWindow | null | undefined, operation: () => Promise<T>): Promise<T> {
      return owners.run(owner ?? null, operation)
    },
    async open(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
      const owner = owners.getStore()
      if (!owner || owner.isDestroyed()) return { canceled: true, filePaths: [] }
      const result = await dialogs.showOpenDialog(owner, options)
      return owner.isDestroyed() ? { canceled: true, filePaths: [] } : result
    },
    async save(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
      const owner = owners.getStore()
      if (!owner || owner.isDestroyed()) return { canceled: true, filePath: '' }
      const result = await dialogs.showSaveDialog(owner, options)
      return owner.isDestroyed() ? { canceled: true, filePath: '' } : result
    }
  }
}
