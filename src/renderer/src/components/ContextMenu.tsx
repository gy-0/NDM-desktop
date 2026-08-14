import { useEffect, useRef } from 'react'
import { Check, Copy, Eye, FolderOpen, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import type { Task } from '../lib/types'

export interface ContextMenuPosition {
  x: number
  y: number
  task: Task
}

export function ContextMenu({
  position,
  onClose,
  onToggle,
  onRestart,
  onQuickLook,
  onReveal,
  onOpen,
  onCopyUrl,
  onDelete
}: {
  position: ContextMenuPosition
  onClose: () => void
  onToggle: (task: Task) => void
  onRestart: (task: Task) => void
  onQuickLook: (task: Task) => void
  onReveal: (task: Task) => void
  onOpen: (task: Task) => void
  onCopyUrl: (task: Task) => void
  onDelete: (task: Task, deleteFile: boolean) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const { task, x, y } = position
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const failed = task.status === 'error'

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  // Adjust menu position to keep within window boundaries
  const menuWidth = 190
  const menuHeight = 260
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 10)
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 10)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-xl border border-line-strong bg-raised/95 py-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl animate-fade-in"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-b border-line/60 px-3 py-1 text-[11px] font-medium text-mist truncate max-w-[170px]">
        {task.title}
      </div>

      <div className="py-1">
        {completed ? (
          <>
            <MenuItem
              icon={Eye}
              label="快速预览"
              shortcut="Space"
              onClick={() => {
                onQuickLook(task)
                onClose()
              }}
            />
            <MenuItem
              icon={FolderOpen}
              label="在访达中显示"
              shortcut="⌘R"
              onClick={() => {
                onReveal(task)
                onClose()
              }}
            />
            <MenuItem
              icon={Play}
              label="打开文件"
              shortcut="↵"
              onClick={() => {
                onOpen(task)
                onClose()
              }}
            />
          </>
        ) : (
          <>
            <MenuItem
              icon={downloading ? Pause : Play}
              label={downloading ? '暂停下载' : '继续下载'}
              shortcut="↵"
              onClick={() => {
                onToggle(task)
                onClose()
              }}
            />
            {failed ? (
              <MenuItem
                icon={RotateCw}
                label="重试下载"
                onClick={() => {
                  onRestart(task)
                  onClose()
                }}
              />
            ) : null}
            <MenuItem
              icon={FolderOpen}
              label="在访达中显示"
              shortcut="⌘R"
              onClick={() => {
                onReveal(task)
                onClose()
              }}
            />
          </>
        )}
      </div>

      <div className="border-t border-line/60 my-1" />

      <div className="py-1">
        <MenuItem
          icon={Copy}
          label="复制下载链接"
          shortcut="⌘C"
          onClick={() => {
            onCopyUrl(task)
            onClose()
          }}
        />
        <MenuItem
          icon={RotateCw}
          label="重新下载"
          onClick={() => {
            onRestart(task)
            onClose()
          }}
        />
      </div>

      <div className="border-t border-line/60 my-1" />

      <div className="py-1">
        <MenuItem
          icon={Trash2}
          label="从列表移除"
          onClick={() => {
            onDelete(task, false)
            onClose()
          }}
        />
        <MenuItem
          icon={Trash2}
          label="移到废纸篓"
          tone="danger"
          shortcut="⌘⌫"
          onClick={() => {
            onDelete(task, true)
            onClose()
          }}
        />
      </div>
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  tone,
  onClick
}: {
  icon: typeof Pause
  label: string
  shortcut?: string
  tone?: 'danger'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-white/10 ${
        tone === 'danger' ? 'text-clay hover:text-clay' : 'text-paper'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={13} className={tone === 'danger' ? 'text-clay' : 'text-mist'} />
        <span>{label}</span>
      </div>
      {shortcut ? <span className="font-mono text-[10px] text-mist">{shortcut}</span> : null}
    </button>
  )
}
