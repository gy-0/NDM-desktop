import { Popover } from '@base-ui/react/popover'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, X } from 'lucide-react'
import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference'
import { formatBytes, taskDisplayTitle } from '../../lib/format'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type Task } from '../../lib/types'
import { TypeMark } from '../Marks'
import './selection-preview.css'

function selectionStatus(task: Task): string {
  if (task.awaitingDestination) return '待选保存目录'
  if (task.status === 'downloading' && task.isLiveRecording) {
    return task.phase === 'merging' ? '正在保存录制' : '正在录制'
  }
  if (task.status === 'downloading' && task.phase && task.phase !== 'transferring') return PHASE_LABEL[task.phase]
  return STATUS_LABEL[task.status]
}

function SelectionFiles({ tasks, scrollRef }: {
  tasks: readonly Task[]
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: index => tasks[index].id,
    estimateSize: () => 76,
    gap: 6,
    paddingStart: 2,
    paddingEnd: 2,
    overscan: 4
  })

  return <div ref={scrollRef} data-selection-preview-list className="selection-preview-list scroll-quiet"
    role="list" aria-label="已选文件列表" tabIndex={0} style={{ height: Math.min(360, Math.max(92, tasks.length * 82 + 4)) }}>
    <div className="selection-preview-list-space" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => {
        const task = tasks[item.index]
        const title = taskDisplayTitle(task)
        const size = task.fileSize > 0 ? formatBytes(task.fileSize)
          : task.completedBytes > 0 ? `已${task.isLiveRecording ? '录制' : '下载'} ${formatBytes(task.completedBytes)}` : '大小未知'
        return <div key={task.id} ref={virtualizer.measureElement} data-index={item.index}
          data-selection-preview-item={task.id} data-status={task.status}
          className="selection-preview-row" role="listitem" aria-posinset={item.index + 1} aria-setsize={tasks.length}
          style={{ transform: `translateY(${item.start}px)` }}>
          <span className="selection-preview-file" aria-hidden><TypeMark category={task.category} size="sm" /></span>
          <div className="selection-preview-file-copy">
            <p className="selection-preview-filename">{title}</p>
            <p className="selection-preview-file-meta"><span>{CATEGORY_LABEL[task.category]} · {size}</span><span className="selection-preview-status">{selectionStatus(task)}</span></p>
          </div>
        </div>
      })}
    </div>
  </div>
}

/** Review the same complete selection that the adjacent batch actions receive. */
export function SelectionPreview({ tasks, children }: { tasks: readonly Task[]; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotionPreference()
  const scrollRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const expanded = open && tasks.length > 0

  return <Popover.Root open={expanded} onOpenChange={setOpen} modal="trap-focus">
    <Popover.Trigger ref={triggerRef} data-selection-preview-trigger className="selection-preview-trigger"
      aria-label="查看已选文件" title="查看已选文件" disabled={!tasks.length}>
      <span data-selection-preview-stack className="selection-preview-stack" aria-hidden>
        {tasks.slice(0, 3).map((task, index) => <span key={task.id} data-selection-preview-sheet={task.id}
          className="selection-preview-sheet" style={{ '--sheet-index': index } as CSSProperties}>
          <TypeMark category={task.category} size="sm" />
        </span>)}
      </span>
      {children}
      <ChevronDown size={12} className="selection-preview-chevron" aria-hidden />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={10} align="start" collisionPadding={12} className="selection-preview-positioner">
        <Popover.Popup data-selection-preview-popup data-reduced-motion={reduced || undefined}
          className="selection-preview-popup" initialFocus={scrollRef} finalFocus={triggerRef}
          inert={!expanded} onKeyDown={event => {
            // Local ownership keeps Space/Delete/selection shortcuts away from
            // the selected downloads underneath this read-only review surface.
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
            event.stopPropagation()
          }}>
          <div className="selection-preview-heading">
            <div><div className="selection-preview-title-row"><Popover.Title className="selection-preview-title">已选文件</Popover.Title><span>{tasks.length.toLocaleString()} 项</span></div>
              <Popover.Description className="selection-preview-description">全部所选文件，可滚动核对</Popover.Description></div>
            <Popover.Close className="selection-preview-close" aria-label="收起已选文件"><X size={15} aria-hidden /></Popover.Close>
          </div>
          <SelectionFiles tasks={tasks} scrollRef={scrollRef} />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
