import { Check, ChevronDown, ChevronRight, Layers3, Pause, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes, formatSpeed, fractionOf } from '../lib/format'
import { pauseCollection, resumeCollection } from '../lib/store'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import type { Task } from '../lib/types'
import { TypeMark } from './Marks'
import { CardContainer } from './ui/card-3d'
import { CardSpotlight } from './ui/card-spotlight'

export function CollectionRow({
  collectionID,
  tasks,
  expanded,
  onToggle
}: {
  collectionID: string
  tasks: Task[]
  expanded: boolean
  onToggle: () => void
}) {
  const ordered = [...tasks].sort((a, b) => (a.collection?.index ?? a.id) - (b.collection?.index ?? b.id))
  const artworkTask = ordered.find((task) => task.thumbnailURL) ?? ordered[0]
  const thumbnail = useTaskThumbnail(artworkTask)
  const count = Math.max(ordered.length, ordered[0]?.collection?.count ?? 0)
  const completed = ordered.filter((task) => task.status === 'complete').length
  const failed = ordered.filter((task) => task.status === 'error').length
  const active = ordered.some((task) => task.status === 'downloading')
  const canPause = ordered.some((task) => task.status === 'downloading' || task.status === 'waiting')
  const canResume = !canPause && ordered.some((task) => task.status === 'paused' || task.status === 'incomplete' || task.status === 'error')
  const resumeLabel = ordered.some((task) => task.status === 'paused' || task.status === 'incomplete')
    ? '继续整个合集'
    : '重试失败项'
  const fraction = ordered.reduce((total, task) => total + fractionOf(task), 0) / Math.max(1, ordered.length)
  const totalBytes = ordered.reduce((total, task) => total + task.fileSize, 0)
  const totalSpeed = ordered.reduce((total, task) => total + task.bytesPerSecond, 0)
  const title = ordered[0]?.collection?.title || '视频合集'
  const statusText = completed === count
    ? `${count} 项全部完成`
    : `${completed}/${count} 已完成${failed > 0 ? ` · ${failed} 项失败` : ''}`
  const [groupActionBusy, setGroupActionBusy] = useState(false)
  const [groupActionError, setGroupActionError] = useState('')

  useEffect(() => {
    setGroupActionError('')
    setGroupActionBusy(false)
  }, [collectionID])

  const handleGroupAction = async (): Promise<void> => {
    if (groupActionBusy) return
    setGroupActionBusy(true)
    setGroupActionError('')
    cue('tick')
    try {
      if (canPause) await pauseCollection(collectionID)
      else if (canResume) await resumeCollection(collectionID)
      cue('success')
    } catch {
      setGroupActionError(
        canPause
          ? '未能暂停整个合集。请检查下载引擎后重试。'
          : '未能继续整个合集。请检查下载引擎后重试。'
      )
      cue('droplet')
    } finally {
      setGroupActionBusy(false)
    }
  }

  return (
    <CardContainer
      containerClassName="mb-1.5"
      className="relative"
    >
      <CardSpotlight radius={260} className="rounded-[14px]">
        <div
          data-collection-group={collectionID}
          className="relative flex min-h-[68px] items-center overflow-hidden rounded-[14px] bg-raised/52 pe-2 shadow-[0_0_0_1px_color-mix(in_srgb,var(--line-strong)_72%,transparent),0_3px_12px_rgba(0,0,0,0.07)]"
        >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}合集 ${title}`}
        onClick={onToggle}
        className="grid min-h-[68px] min-w-0 flex-1 grid-cols-[52px_minmax(0,1fr)_auto_18px] items-center gap-3 ps-3 pe-2 text-start"
      >
        <span className="relative grid h-9 w-12 shrink-0 place-items-center">
          <span aria-hidden className="absolute inset-x-1 -top-1 h-8 rounded-[8px] bg-panel shadow-[0_0_0_1px_var(--line)]" />
          <span className="relative grid h-9 w-12 place-items-center overflow-hidden rounded-[9px] bg-raised shadow-[0_0_0_1px_var(--line-strong)]">
            {thumbnail ? (
              <img
                src={thumbnail}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className="t-skel-content media-thumbnail h-full w-full rounded-[9px] object-cover"
              />
            ) : artworkTask ? (
              <TypeMark category={artworkTask.category} size="sm" />
            ) : (
              <Layers3 size={16} className="text-mist" />
            )}
          </span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium text-paper/94" title={title}>{title}</span>
          <span
            id={`collection-action-status-${collectionID}`}
            role={groupActionError ? 'status' : undefined}
            aria-live="polite"
            className={`mt-1 flex items-center gap-1.5 text-[10.5px] ${groupActionError ? 'text-clay' : 'text-fog'}`}
          >
            {completed === count ? <Check size={11} strokeWidth={2} className="text-sage" /> : failed > 0 ? <TriangleAlert size={11} className="text-clay" /> : <Layers3 size={11} />}
            <span>{groupActionError || statusText}</span>
          </span>
        </span>
        <span className="whitespace-nowrap text-end font-mono text-[10.5px] tabular-nums text-mist">
          {active && totalSpeed > 0 ? `${formatSpeed(totalSpeed).value} ${formatSpeed(totalSpeed).unit}` : formatBytes(totalBytes)}
        </span>
        {expanded ? <ChevronDown size={14} className="text-mist" /> : <ChevronRight size={14} className="text-mist" />}
      </button>
      {canPause || canResume ? (
        <button
          type="button"
          title={canPause ? '暂停整个合集' : resumeLabel}
          aria-label={canPause ? '暂停整个合集' : resumeLabel}
          disabled={groupActionBusy}
          aria-describedby={groupActionError ? `collection-action-status-${collectionID}` : undefined}
          onClick={() => void handleGroupAction()}
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-mist transition-[color,background-color,scale] duration-100 hover:bg-line hover:text-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
        >
          {canPause ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
      ) : null}
      {completed < count ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px overflow-hidden rounded-full bg-line">
          <div
            className={`h-full w-full rounded-full transition-transform duration-150 ease-linear ${active ? 'bg-copper' : 'bg-mist'}`}
            style={{ transform: `scaleX(${Math.max(0.01, fraction)})`, transformOrigin: 'left center' }}
          />
        </div>
      ) : null}
    </div>
      </CardSpotlight>
    </CardContainer>
  )
}
