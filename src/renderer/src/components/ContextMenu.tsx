import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { useMemo } from 'react'
import { Check, Copy, Eye, FolderOpen, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import type { Task } from '../lib/types'
import { COMMAND_KEY, FILE_MANAGER, TRASH_NAME } from '../lib/platform'

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
  const { task, x, y } = position
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const failed = task.status === 'error'
  const pointerAnchor = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }),
    [x, y]
  )

  return (
    <BaseContextMenu.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner
          anchor={pointerAnchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          collisionPadding={10}
          collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
          className="z-50 outline-none"
        >
          <BaseContextMenu.Popup
            aria-label={`${task.title} 的任务菜单`}
            finalFocus={false}
            className="min-w-[196px] max-w-[240px] max-h-[calc(100vh-20px)] overflow-y-auto rounded-[12px] bg-raised/98 py-1.5 outline-none shadow-[0_0_0_1px_var(--line-strong),0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 transition-[scale,opacity] duration-100"
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
              }}
            />
            <MenuItem
              icon={FolderOpen}
              label={`在${FILE_MANAGER}中显示`}
              shortcut={`${COMMAND_KEY}+R`}
              onClick={() => {
                onReveal(task)
              }}
            />
            <MenuItem
              icon={Play}
              label="打开文件"
              shortcut="↵"
              onClick={() => {
                onOpen(task)
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
              }}
            />
            {failed ? (
              <MenuItem
                icon={RotateCw}
                label="重试下载"
                onClick={() => {
                  onRestart(task)
                }}
              />
            ) : null}
            <MenuItem
              icon={FolderOpen}
              label={`在${FILE_MANAGER}中显示`}
              shortcut={`${COMMAND_KEY}+R`}
              onClick={() => {
                onReveal(task)
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
          shortcut={`${COMMAND_KEY}+C`}
          onClick={() => {
            onCopyUrl(task)
          }}
        />
        {completed ? (
          <MenuItem
            icon={RotateCw}
            label="重新下载"
            onClick={() => {
              onRestart(task)
            }}
          />
        ) : null}
      </div>

      <div className="mx-2 my-1 border-t border-line/60" />

      <div className="py-1">
        <MenuItem
          icon={Trash2}
          label="从列表移除"
          onClick={() => {
            onDelete(task, false)
          }}
        />
        <MenuItem
          icon={Trash2}
          label={`移到${TRASH_NAME}`}
          tone="danger"
          shortcut={`${COMMAND_KEY}+Delete`}
          onClick={() => {
            onDelete(task, true)
          }}
        />
      </div>
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
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
    <BaseContextMenu.Item
      onClick={onClick}
      data-cuelume-press="tick"
      className={`mx-1.5 flex h-8 w-[calc(100%_-_12px)] cursor-default items-center justify-between rounded-[7px] px-2 text-left text-[12px] outline-none transition-[color,background-color,scale] duration-50 active:scale-[0.96] ${
        tone === 'danger'
          ? 'text-clay hover:bg-clay/15 data-[highlighted]:bg-clay/15'
          : 'text-paper hover:bg-line-strong data-[highlighted]:bg-line-strong'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.5} className={tone === 'danger' ? 'text-clay' : 'text-mist'} />
        <span>{label}</span>
      </div>
      {shortcut ? <span className="font-mono text-[10px] text-mist">{shortcut}</span> : null}
    </BaseContextMenu.Item>
  )
}
