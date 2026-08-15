import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const [placement, setPlacement] = useState({ left: x, top: y, ready: false })

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

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPlacement({
      left: Math.max(10, Math.min(x, window.innerWidth - rect.width - 10)),
      top: Math.max(10, Math.min(y, window.innerHeight - rect.height - 10)),
      ready: true
    })
  }, [x, y, completed, downloading, failed])

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${task.title} 的任务菜单`}
      className="fixed z-50 min-w-[196px] max-w-[240px] max-h-[calc(100vh-20px)] overflow-y-auto rounded-[12px] bg-raised/98 py-1.5 shadow-[0_0_0_1px_var(--line-strong),0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl"
      style={{ left: placement.left, top: placement.top, visibility: placement.ready ? 'visible' : 'hidden' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-1.5 mb-1 truncate border-b border-line/60 px-2 py-1.5 text-[12.5px] text-fog" title={task.filename}>
        {task.filename || task.title}
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

      <div className="mx-2 my-1 border-t border-line/60" />

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

      <div className="mx-2 my-1 border-t border-line/60" />

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
      role="menuitem"
      onClick={onClick}
      data-cuelume-press="tick"
      className={`mx-1.5 flex h-8 w-[calc(100%_-_12px)] items-center justify-between rounded-[7px] px-2 text-left text-[12px] outline-none transition-[color,background-color,scale] duration-50 active:scale-[0.98] ${
        tone === 'danger'
          ? 'text-clay hover:bg-clay/15 focus-visible:bg-clay/15'
          : 'text-paper hover:bg-line-strong focus-visible:bg-line-strong'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.5} className={tone === 'danger' ? 'text-clay' : 'text-mist'} />
        <span>{label}</span>
      </div>
      {shortcut ? <span className="font-mono text-[10px] text-mist">{shortcut}</span> : null}
    </button>
  )
}
