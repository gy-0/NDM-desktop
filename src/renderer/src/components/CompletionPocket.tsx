import { ArrowUpRight, Check, ChevronDown, Eye, File, FileArchive, FileImage, FileText, Film, FolderOpen, Layers3, Music2, Package, X, type LucideIcon } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { CATEGORY_LABEL, type DownloadCategory, type Task } from '../lib/types'
import { formatBytes, formatDownloadTime, taskDisplayTitle } from '../lib/format'
import { FILE_MANAGER } from '../lib/platform'
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
function PocketArtwork({ task, compact = false }: { task: Task; compact?: boolean }) {
  const artwork = useTaskThumbnail(task)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const image = artwork?.source !== failedSource ? artwork : null
  const Icon = FILE_ICONS[task.category]
  return <span className="completion-pocket-artwork" data-artwork={image?.kind ?? 'type'} data-compact={compact || undefined} aria-hidden="true">
    {image ? <img src={image.source} alt="" draggable={false} onError={() => setFailedSource(image.source)} /> : <>
      <Icon size={compact ? 26 : 38} strokeWidth={1.25} />
      {!compact ? <span className="completion-pocket-extension">{fileExtension(task)}</span> : null}
    </>}
  </span>
}

/** A recent-file shelf. File actions remain owned by the existing app handlers. */
export function CompletionPocket({ tasks, selectedTaskId, onSelect, onFileCommand }: CompletionPocketProps) {
  const recent = useMemo(() => [...new Map(tasks.filter(task => task.status === 'complete').map(task => [task.id, task])).values()]
    .sort((left, right) => (right.completedAt ?? right.activityAt ?? 0) - (left.completedAt ?? left.activityAt ?? 0) || right.id - left.id)
    .slice(0, 5), [tasks])
  const [expanded, setExpanded] = useState(false)
  const [localSelectedId, setSelectedId] = useState<number | null>(null)
  const selectedId = selectedTaskId === undefined ? localSelectedId : selectedTaskId
  const trigger = useRef<HTMLButtonElement>(null)
  const openingControl = useRef<HTMLButtonElement | null>(null)
  const overview = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const headingId = useId()

  const close = (): void => {
    const origin = openingControl.current?.isConnected ? openingControl.current : trigger.current
    origin?.focus({ preventScroll: true })
    setExpanded(false)
  }
  const toggle = (control: HTMLButtonElement): void => {
    openingControl.current = control
    if (expanded) close()
    else setExpanded(true)
  }

  useLayoutEffect(() => {
    if (!expanded) return
    // Opening is the only automatic focus movement. New completed tasks do
    // not take focus from a file action that the user is already reaching for.
    const current = overview.current?.querySelector<HTMLButtonElement>('[data-pocket-select][aria-pressed="true"]')
    const first = overview.current?.querySelector<HTMLButtonElement>('[data-pocket-select]')
    const target = current ?? first
    target?.focus({ preventScroll: true })
  }, [expanded])

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return
    if (expanded && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const target = event.target as HTMLElement
    // The window also has task shortcuts. Native button activation belongs to
    // this shelf when one of its controls has focus.
    if ((event.key === 'Enter' || event.key === ' ') && target.closest('button')) event.stopPropagation()
    if (!target.closest('[data-pocket-select]')) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(overview.current?.querySelectorAll<HTMLButtonElement>('[data-pocket-select]') ?? [])
    const index = buttons.indexOf(target.closest<HTMLButtonElement>('[data-pocket-select]')!)
    if (index < 0) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  if (!recent.length) return null
  const latest = recent[0]

  return <section className="completion-pocket" data-completion-pocket data-expanded={expanded} aria-labelledby={headingId} onKeyDown={onKeyDown}>
    <div className="completion-pocket-header">
      <div className="completion-pocket-intro">
        <span className="completion-pocket-kicker"><span className="completion-pocket-check"><Check size={10} strokeWidth={2} aria-hidden /></span>已完成的下载</span>
        <h2 id={headingId}>最近完成</h2>
        <p className="completion-pocket-latest" title={taskDisplayTitle(latest)}>{taskDisplayTitle(latest)}</p>
        <div className="completion-pocket-header-bottom">
          <span className="completion-pocket-quantity">{CATEGORY_LABEL[latest.category]}<span aria-hidden> · </span>{fileSize(latest)}</span>
          <button ref={trigger} type="button" className="completion-pocket-trigger" aria-expanded={expanded} aria-controls={panelId}
            onClick={event => toggle(event.currentTarget)}>
            {expanded ? '收起文件' : '展开文件'}<ChevronDown size={14} aria-hidden />
          </button>
        </div>
      </div>

      <button type="button" className="completion-pocket-stage" aria-label={expanded ? '收起文件口袋' : '展开最近完成文件'}
        aria-expanded={expanded} aria-controls={panelId} onClick={event => toggle(event.currentTarget)}>
        <span className="completion-pocket-stage-art" aria-hidden="true">
        <span className="completion-pocket-back" />
        {recent.map((task, index) => <span key={task.id} className="completion-pocket-paper" data-pocket-paper={task.id}
          style={{ '--pocket-position': FAN_POSITIONS[index], '--pocket-depth': Math.abs(FAN_POSITIONS[index]), zIndex: 8 - index } as CSSProperties}>
          <span className="completion-pocket-paper-type">{fileExtension(task)}</span>
          <PocketArtwork task={task} compact />
          <span className="completion-pocket-paper-name">{taskDisplayTitle(task)}</span>
        </span>)}
        <span className="completion-pocket-front">
          <FolderOpen size={17} strokeWidth={1.35} />
          <span>最近文件</span>
          <span className="completion-pocket-front-count">{recent.length.toString().padStart(2, '0')}</span>
        </span>
        <span className="completion-pocket-shadow" />
        </span>
      </button>
    </div>

    <div id={panelId} className="completion-pocket-reveal" inert={!expanded} aria-hidden={!expanded || undefined}>
      <div className="completion-pocket-reveal-inner">
        <div className="completion-pocket-overview-heading">
          <span><Layers3 size={14} aria-hidden />最近 {recent.length} 个文件</span>
          <button type="button" aria-label="收起最近完成文件" title="收起 · Esc" onClick={close}><X size={15} aria-hidden /></button>
        </div>
        <div ref={overview} className="completion-pocket-overview scroll-quiet" role="group" aria-label="最近完成的文件">
          {recent.map(task => {
            const title = taskDisplayTitle(task)
            return <article key={task.id} className="completion-pocket-card" data-selected={selectedId === task.id}>
              <button type="button" data-pocket-select={task.id} className="completion-pocket-select" aria-pressed={selectedId === task.id}
                aria-label={`选择文件：${title}`} onClick={() => { setSelectedId(task.id); onSelect(task) }}>
                <span className="completion-pocket-card-preview"><PocketArtwork task={task} /><span className="completion-pocket-card-type">{CATEGORY_LABEL[task.category]}</span></span>
                <span className="completion-pocket-card-name" title={title}>{title}</span>
                <span className="completion-pocket-card-meta"><span>{fileSize(task)}</span><span>{task.completedAt ? formatDownloadTime(task.completedAt) : '已完成'}</span></span>
              </button>
              <div className="completion-pocket-card-actions" role="group" aria-label={`${title}的文件操作`}>
                <button type="button" className="completion-pocket-open" aria-label={`打开文件：${title}`} onClick={() => onFileCommand(task, 'open')}><ArrowUpRight size={14} aria-hidden />打开</button>
                <button type="button" title="快速预览" aria-label={`预览文件：${title}`} onClick={() => onFileCommand(task, 'preview')}><Eye size={15} aria-hidden /></button>
                <button type="button" title={`在${FILE_MANAGER}中显示`} aria-label={`在${FILE_MANAGER}中显示：${title}`} onClick={() => onFileCommand(task, 'reveal')}><FolderOpen size={15} aria-hidden /></button>
              </div>
            </article>
          })}
        </div>
      </div>
    </div>
  </section>
}
