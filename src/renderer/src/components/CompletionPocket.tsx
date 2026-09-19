import { Check, File, FileArchive, FileImage, FileText, Film, FolderOpen, Music2, Package, type LucideIcon } from 'lucide-react'
import { useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { CATEGORY_LABEL, type DownloadCategory, type Task } from '../lib/types'
import { formatBytes, taskDisplayTitle } from '../lib/format'
import { completedDragPaths } from '../lib/fileDrag'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import './ui/completion-pocket.css'

export interface CompletionPocketProps {
  tasks: Task[]
  selectedTaskId?: number | null
  onSelect: (task: Task) => void
  onFileCommand: (task: Task, action: 'open' | 'preview' | 'reveal') => void
}

const FILE_ICONS: Record<DownloadCategory, LucideIcon> = {
  video: Film, audio: Music2, document: FileText, compressed: FileArchive,
  application: Package, image: FileImage, misc: File
}
const FAN_POSITIONS = [0, -1, 1, -2, 2]

function fileSize(task: Task): string {
  const bytes = task.fileSize || task.completedBytes
  return bytes > 0 ? formatBytes(bytes) : '大小未知'
}

function fileExtension(task: Task): string {
  const match = task.filename.match(/\.([a-zA-Z0-9]{1,8})$/)
  return match ? match[1].toUpperCase() : CATEGORY_LABEL[task.category]
}

/** Only real task artwork is shown. A file-type mark is the explicit fallback. */
function PocketArtwork({ task }: { task: Task }) {
  const artwork = useTaskThumbnail(task)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const image = artwork?.source !== failedSource ? artwork : null
  const Icon = FILE_ICONS[task.category]
  return <span className="completion-pocket-artwork" data-artwork={image?.kind ?? 'type'} aria-hidden="true">
    {image ? <img src={image.source} alt="" draggable={false} onError={() => setFailedSource(image.source)} /> : <Icon size={26} strokeWidth={1.25} />}
  </span>
}

/**
 * A tray of the five most recent files. Each sheet is the file itself: drag
 * it into another app, press Space to preview, click to locate it in the
 * library. There is no second list; the fan is the whole interface.
 */
export function CompletionPocket({ tasks, selectedTaskId, onSelect, onFileCommand }: CompletionPocketProps) {
  const recent = useMemo(() => [...new Map(tasks.filter(task => task.status === 'complete').map(task => [task.id, task])).values()]
    .sort((left, right) => (right.completedAt ?? right.activityAt ?? 0) - (left.completedAt ?? left.activityAt ?? 0) || right.id - left.id)
    .slice(0, 5), [tasks])
  const stage = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const hintId = useId()

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    const paper = target.closest<HTMLButtonElement>('[data-pocket-paper]')
    if (!paper) return
    const task = recent.find(item => String(item.id) === paper.dataset.pocketPaper)
    if (!task) return
    // The window also owns task shortcuts; a focused sheet answers first.
    if (event.key === ' ' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) onFileCommand(task, 'preview')
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) onFileCommand(task, 'open')
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const papers = Array.from(stage.current?.querySelectorAll<HTMLButtonElement>('[data-pocket-paper]') ?? [])
    const index = papers.indexOf(paper)
    if (index < 0) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? papers.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + papers.length) % papers.length
    papers[next]?.focus({ preventScroll: true })
  }

  function onDragStart(event: DragEvent<HTMLButtonElement>, task: Task): void {
    event.preventDefault()
    event.stopPropagation()
    const files = completedDragPaths(task, [task], new Set())
    if (files.length) window.ndm?.startFileDrag?.(files)
  }

  if (!recent.length) return null
  const latest = recent[0]

  return <section className="completion-pocket" data-completion-pocket aria-labelledby={headingId} onKeyDown={onKeyDown}>
    <div className="completion-pocket-header">
      <div className="completion-pocket-intro">
        <span className="completion-pocket-kicker"><span className="completion-pocket-check"><Check size={10} strokeWidth={2} aria-hidden /></span>已完成的下载</span>
        <h2 id={headingId}>最近完成</h2>
        <p className="completion-pocket-latest" title={taskDisplayTitle(latest)}>{taskDisplayTitle(latest)}</p>
        <p id={hintId} className="completion-pocket-hint">
          <span className="completion-pocket-quantity">{CATEGORY_LABEL[latest.category]}<span aria-hidden> · </span>{fileSize(latest)}</span>
          <span>把文件拖到其他 App，或按空格预览</span>
        </p>
      </div>

      <div ref={stage} className="completion-pocket-stage" role="group" aria-label="最近完成的文件" aria-describedby={hintId}>
        <span className="completion-pocket-back" aria-hidden="true" />
        {recent.map((task, index) => {
          const title = taskDisplayTitle(task)
          const selected = selectedTaskId === task.id
          return <button key={task.id} type="button" className="completion-pocket-paper" data-pocket-paper={task.id} data-category={task.category}
            data-selected={selected || undefined} aria-pressed={selected}
            aria-label={`${title} · ${fileExtension(task)} · ${fileSize(task)}`}
            title={`${title}\n点击定位 · 空格预览 · 回车打开 · 可拖出`}
            draggable onDragStart={event => onDragStart(event, task)}
            onClick={() => onSelect(task)}
            style={{ '--pocket-position': FAN_POSITIONS[index], '--pocket-depth': Math.abs(FAN_POSITIONS[index]), zIndex: 8 - index } as CSSProperties}>
            <span className="completion-pocket-paper-type">{fileExtension(task)}</span>
            <PocketArtwork task={task} />
            <span className="completion-pocket-paper-name">{title}</span>
          </button>
        })}
        <span className="completion-pocket-front" aria-hidden="true">
          <FolderOpen size={17} strokeWidth={1.35} />
          <span>最近文件</span>
          <span className="completion-pocket-front-count">{recent.length.toString().padStart(2, '0')}</span>
        </span>
        <span className="completion-pocket-shadow" aria-hidden="true" />
      </div>
    </div>
  </section>
}
