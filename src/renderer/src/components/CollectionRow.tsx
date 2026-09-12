import { Check, ChevronDown, ChevronRight, Layers3, Pause, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes, formatDownloadTime, formatSpeed, fractionOf } from '../lib/format'
import { pauseCollection, resumeCollection } from '../lib/store'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import type { Task } from '../lib/types'
import { SmoothProgressBar } from './SmoothProgressBar'
import { TypeMark } from './Marks'

export function CollectionRow({
  collectionID,
  transferView = true,
  tasks,
  expanded,
  onToggle,
  actionBlocked = false,
  onAction,
  columnTemplate
}: {
  transferView?: boolean
  collectionID: string
  tasks: Task[]
  expanded: boolean
  onToggle: () => void
  actionBlocked?: boolean
  onAction: (operation: () => Promise<void>) => Promise<void>
  columnTemplate: string
}) {
  const ordered = [...tasks].sort((a, b) => (a.collection?.index ?? a.id) - (b.collection?.index ?? b.id))
  const artworkTask = ordered.find((task) => task.thumbnailURL) ?? ordered[0]
  const artwork = useTaskThumbnail(artworkTask)
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
    if (groupActionBusy || actionBlocked) return
    setGroupActionBusy(true)
    setGroupActionError('')
    cue('tick')
    try {
      await onAction(async () => {
        if (canPause) await pauseCollection(collectionID)
        else if (canResume) await resumeCollection(collectionID)
      })
      cue('success')
    } catch {
      setGroupActionError(
        canPause
          ? '未能暂停整个合集。请重试。'
          : '未能继续整个合集。请重试。'
      )
      cue('droplet')
    } finally {
      setGroupActionBusy(false)
    }
  }

  return (
    <div
      data-collection-group={collectionID}
      className="group relative rounded-[9px] border border-line/55 bg-raised/22 transition-[background-color,border-color,box-shadow] duration-150 hover:border-line-strong/60 hover:bg-raised/44 hover:shadow-row"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}合集 ${title}`}
        onClick={onToggle}
        className="task-table-row grid h-[72px] w-full items-center text-start"
        style={{ gridTemplateColumns: columnTemplate }}
      >
        <span data-collection-heading className="flex min-w-0 items-center gap-3 px-3 pe-5">
          <span className="grid size-5 shrink-0 place-items-center text-mist">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span
            data-task-artwork-slot
            className={`grid h-9 w-12 shrink-0 place-items-center ${artwork?.kind === 'preview' ? 'overflow-hidden rounded-[6px] bg-ink/35' : ''}`}
          >
            {artwork ? (
              <img
                data-task-artwork
                data-artwork-kind={artwork.kind}
                src={artwork.source}
                alt=""
                aria-hidden
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('is-revealed')}
                className={`t-skel-content ${artwork.kind === 'icon' ? 'size-9 rounded-[9px] object-contain' : 'media-thumbnail h-9 w-12 rounded-[6px] object-cover'}`}
              />
            ) : artworkTask ? (
              <TypeMark category={artworkTask.category} size="sm" />
            ) : (
              <span className="grid size-9 place-items-center text-mist"><Layers3 size={16} /></span>
            )}
          </span>
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
          {transferView && active && totalSpeed > 0 ? `${formatSpeed(totalSpeed).value} ${formatSpeed(totalSpeed).unit}` : formatBytes(totalBytes)}
        </span>
        <span className="whitespace-nowrap pe-4 text-right text-[11.5px] tabular-nums text-mist" title={latestActivityAt ? new Date(latestActivityAt).toLocaleString('zh-CN') : undefined}>
          {formatDownloadTime(latestActivityAt)}
        </span>
        <span className="task-row-progress flex items-center gap-2.5 !pe-12">
          {completed < count && fraction > 0 ? (
            <>
              <span className="w-9 text-end font-mono text-[11.5px] tabular-nums text-mist">{Math.round(fraction * 100)}%</span>
              <SmoothProgressBar fraction={fraction} active={active}
                fillClassName={failed > 0 ? 'bg-clay' : active ? 'bg-paper/76' : 'bg-mist'}
                trackClassName={active ? 'task-progress-warp' : ''} />
            </>
          ) : null}
        </span>
      </button>
      {canPause || canResume ? (
        <button
          type="button"
          title={canPause ? '暂停整个合集' : resumeLabel}
          aria-label={canPause ? '暂停整个合集' : resumeLabel}
          disabled={groupActionBusy || actionBlocked}
          aria-describedby={groupActionError ? `collection-action-status-${collectionID}` : undefined}
          onClick={() => void handleGroupAction()}
          aria-busy={groupActionBusy || undefined}
          className="task-primary-action absolute right-10 top-1/2 w-[104px] -translate-y-1/2"
        >
          {canPause ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          <span>{groupActionBusy ? '正在处理' : canPause ? '暂停合集' : resumeLabel === '重试失败项' ? '重试失败项' : '继续合集'}</span>
        </button>
      ) : null}
    </div>
  )
}
