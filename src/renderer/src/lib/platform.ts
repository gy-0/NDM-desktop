export const IS_WINDOWS = typeof window !== 'undefined' && window.ndm?.platform === 'win32'
export const FILE_MANAGER = IS_WINDOWS ? '文件资源管理器' : '访达'
export const TRASH_NAME = IS_WINDOWS ? '回收站' : '废纸篓'
export const COMMAND_KEY = IS_WINDOWS ? 'Ctrl' : '⌘'

export function connectionOptionsForPlatform(isWindows: boolean): readonly number[] {
  return isWindows ? [4, 8, 16] : [4, 8, 16, 32]
}

export const CONNECTION_OPTIONS = connectionOptionsForPlatform(IS_WINDOWS)
