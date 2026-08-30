import { Check, ChevronDown, ChevronRight, Layers3, Pause, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes, formatDownloadTime, formatSpeed, fractionOf } from '../lib/format'
import { pauseCollection, resumeCollection } from '../lib/store'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import type { Task } from '../lib/types'
import { TypeMark } from './Marks'

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
  const latestActivityAt = ordered.reduce<number | undefined>((latest, task) => {
    if (task.activityAt == null) return latest
    return latest == null ? task.activityAt : Math.max(latest, task.activityAt)
  }, undefined)
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
    <div
      data-collection-group={collectionID}
      className="group relative rounded-[9px] border border-line/55 bg-raised/22 transition-[background-color,border-color,box-shadow] duration-150 hover:border-line-strong/60 hover:bg-raised/44 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.024)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}合集 ${title}`}
        onClick={onToggle}
        className="grid h-[72px] w-full grid-cols-[minmax(220px,1fr)_88px_112px_108px_124px] items-center text-start"
      >
        <span className="flex min-w-0 items-center gap-3 px-3 pe-5">
          <span className="grid size-5 shrink-0 place-items-center text-mist">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {thumbnail ? (
            <span className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded-[6px] bg-ink/35 shadow-[inset_0_0_0_1px_var(--line)]">
              <img
                src={thumbnail}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className="t-skel-content media-thumbnail h-full w-full rounded-[6px] object-cover"
              />
            </span>
          ) : artworkTask ? (
            <TypeMark category={artworkTask.category} size="sm" />
          ) : (
            <span className="grid size-9 place-items-center text-mist"><Layers3 size={16} /></span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[14.5px] font-medium text-paper/96" title={title}>{title}</span>
            <span
              id={`collection-action-status-${collectionID}`}
              role={groupActionError ? 'status' : undefined}
              aria-live="polite"
              className={`mt-1.5 flex items-center gap-1.5 text-[11.5px] ${groupActionError ? 'text-clay' : 'text-fog'}`}
            >
              {completed === count ? <Check size={11} strokeWidth={2} className="text-sage" /> : failed > 0 ? <TriangleAlert size={11} className="text-clay" /> : <Layers3 size={11} />}
              <span className="truncate">{groupActionError || statusText}</span>
            </span>
          </span>
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-mist">{completed === count ? '完成' : `${completed}/${count}`}</span>
        <span className="whitespace-nowrap pe-5 text-right font-mono text-[12px] tabular-nums text-mist">
          {active && totalSpeed > 0 ? `${formatSpeed(totalSpeed).value} ${formatSpeed(totalSpeed).unit}` : formatBytes(totalBytes)}
        </span>
        <span className="whitespace-nowrap pe-4 text-right text-[11.5px] tabular-nums text-mist" title={latestActivityAt ? new Date(latestActivityAt).toLocaleString('zh-CN') : undefined}>
          {formatDownloadTime(latestActivityAt)}
        </span>
        <span className="flex items-center gap-2.5 pe-4 transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0">
          {completed < count && fraction > 0 ? (
            <>
              <span className="w-9 text-end font-mono text-[11.5px] tabular-nums text-mist">{Math.round(fraction * 100)}%</span>
              <span className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line/80">
                <span
                  className={`block h-full w-full rounded-[2px] transition-transform duration-[320ms] ease-linear ${failed > 0 ? 'bg-clay' : active ? 'bg-paper/76' : 'bg-mist'}`}
                  style={{ transform: `scaleX(${Math.max(0.01, fraction)})`, transformOrigin: 'left center' }}
                />
              </span>
            </>
          ) : null}
        </span>
      </button>
      {canPause || canResume ? (
        <button
          type="button"
          title={canPause ? '暂停整个合集' : resumeLabel}
          aria-label={canPause ? '暂停整个合集' : resumeLabel}
          disabled={groupActionBusy}
          aria-describedby={groupActionError ? `collection-action-status-${collectionID}` : undefined}
          onClick={() => void handleGroupAction()}
          className="absolute right-4 top-1/2 grid size-[30px] -translate-y-1/2 place-items-center rounded-[7px] text-mist opacity-0 transition-[color,background-color,box-shadow,opacity] duration-100 hover:bg-paper/[0.075] hover:text-paper hover:shadow-[inset_0_0_0_1px_var(--line)] group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-50"
        >
          {canPause ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
      ) : null}
    </div>
  )
}
