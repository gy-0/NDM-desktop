import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { useMemo, useRef } from 'react'
import { Copy, Eye, FolderOpen, Square, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import type { Task } from '../lib/types'
import { COMMAND_KEY, FILE_MANAGER, TRASH_NAME } from '../lib/platform'
import './ui/context-menu.css'

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
  position: ContextMenuPosition | null
  onClose: () => void
  onToggle: (task: Task) => void
  onRestart: (task: Task) => void
  onQuickLook: (task: Task) => void
  onReveal: (task: Task) => void
  onOpen: (task: Task) => void
  onCopyUrl: (task: Task) => void
  onDelete: (task: Task, deleteFile: boolean) => void
}) {
  // Keep the last identity through Base UI's exit; actions are unavailable as
  // soon as Root closes, and the next opening receives the new task/anchor.
  const previous = useRef(position)
  if (position) previous.current = position
  const current = position ?? previous.current
  const task = current?.task
  const x = current?.x ?? 0
  const y = current?.y ?? 0
  const completed = task?.status === 'complete'
  const downloading = task?.status === 'downloading' || task?.status === 'waiting'
  const failed = task?.status === 'error'
  const pointerAnchor = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }),
    [x, y]
  )

  return (
    <BaseContextMenu.Root open={Boolean(position)} onOpenChange={(open) => { if (!open) onClose() }}>
      {task ? <BaseContextMenu.Portal>
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
            data-task-context-menu
            aria-label={`${task.title} 的任务菜单`}
            finalFocus={() => document.querySelector<HTMLButtonElement>(`[data-task-select="${task.id}"]`) ?? document.getElementById('ndm-search')}
            className="ndm-context-menu min-w-[220px] max-w-[280px] max-h-[calc(100dvh-20px)] overflow-y-auto rounded-xl bg-raised py-1.5 outline-none shadow-dialog"
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
            {!failed ? <MenuItem
              icon={task.awaitingDestination ? FolderOpen : downloading && task.isLiveRecording ? Square : downloading ? Pause : Play}
              label={task.awaitingDestination ? '选择保存位置' : downloading && task.isLiveRecording ? '停止并保存' : downloading ? '暂停下载' : '继续下载'}
              shortcut="↵"
              onClick={() => {
                onToggle(task)
              }}
            /> : null}
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
      </BaseContextMenu.Portal> : null}
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
      className={`ndm-context-menu-item mx-1.5 flex h-8 w-[calc(100%_-_12px)] cursor-default items-center justify-between gap-4 rounded-control px-2 text-left text-[12.5px] outline-none ${
        tone === 'danger'
          ? 'text-clay hover:bg-clay/15 data-[highlighted]:bg-clay/15'
          : 'text-paper hover:bg-line-strong data-[highlighted]:bg-line-strong'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.5} aria-hidden className={`shrink-0 ${tone === 'danger' ? 'text-clay' : 'text-mist'}`} />
        <span>{label}</span>
      </div>
      {shortcut ? <span className="shrink-0 font-mono text-[10px] text-mist">{shortcut}</span> : null}
    </BaseContextMenu.Item>
  )
}
