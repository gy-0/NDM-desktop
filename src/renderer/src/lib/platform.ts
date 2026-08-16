export const IS_WINDOWS = typeof window !== 'undefined' && window.ndm?.platform === 'win32'
export const FILE_MANAGER = IS_WINDOWS ? '文件资源管理器' : '访达'
export const TRASH_NAME = IS_WINDOWS ? '回收站' : '废纸篓'
export const COMMAND_KEY = IS_WINDOWS ? 'Ctrl' : '⌘'
