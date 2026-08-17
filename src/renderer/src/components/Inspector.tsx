import { CalendarDays, Captions, Check, ChevronDown, ChevronRight, Clock3, Cloud, Copy, ExternalLink, Eye, FileText, FolderOpen, ImageIcon, Minus, Music, Pause, Play, Plus, RefreshCcw, RotateCw, Share2, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes, formatEta, fractionOf, isDistinctTitle, remainingSeconds } from '../lib/format'
import {
  copyToClipboard,
  getCompletionStack,
  openExternal,
  openFile,
  quickLook,
  remove,
  renewTask,
  restartTask,
  revealFile,
  scheduleTask,
  setTaskBandwidth,
  setTaskConnections,
  shareFile,
  toggle
} from '../lib/store'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type CompletionArtifact, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { requiresPro } from '../lib/license'
import { useTaskThumbnail } from '../lib/taskThumbnail'
import { FILE_MANAGER, IS_WINDOWS, TRASH_NAME } from '../lib/platform'
import { ProChip } from './ProChip'

export function Inspector({
  task,
  onClose,
  onUpgrade
}: {
  task: Task
  onClose: () => void
  onUpgrade: (reason: string) => void
}) {
  const fraction = fractionOf(task)
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const failed = task.status === 'error'
  const [copiedSource, setCopiedSource] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRenew, setShowRenew] = useState(false)
  const [renewURL, setRenewURL] = useState(task.url)
  const [renewError, setRenewError] = useState<string | null>(null)
  const [scheduleDate, setScheduleDate] = useState(() => formatScheduleDate(task.startAt))
  const [scheduleTime, setScheduleTime] = useState(() => formatScheduleTime(task.startAt))
  const [completionArtifacts, setCompletionArtifacts] = useState<CompletionArtifact[]>([])
  const [completionFilesExpanded, setCompletionFilesExpanded] = useState(false)
  const thumbnail = useTaskThumbnail(task)
  const sourceURL = task.pageURL && task.pageURL !== task.url ? task.pageURL : null
  const customStartAt = parseScheduleInput(scheduleDate, scheduleTime)

  useEffect(() => {
    setScheduleDate(formatScheduleDate(task.startAt))
    setScheduleTime(formatScheduleTime(task.startAt))
  }, [task.id, task.startAt])

  useEffect(() => {
    let cancelled = false
    setCompletionFilesExpanded(false)
    if (!completed) {
      setCompletionArtifacts([])
      return () => { cancelled = true }
    }
    setCompletionArtifacts([])
    void getCompletionStack(task.id)
      .then((artifacts) => {
        if (!cancelled) setCompletionArtifacts(artifacts)
      })
      .catch(() => {
        if (!cancelled) setCompletionArtifacts([])
      })
    return () => { cancelled = true }
  }, [completed, task.id, task.filename, task.folderPath])

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename

  const handleCopyLink = (): void => {
    void copyToClipboard(task.url).then(() => {
      cue('success')
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1500)
    })
  }

  const handleCopySource = (): void => {
    if (!sourceURL) return
    void copyToClipboard(sourceURL).then(() => {
      cue('success')
      setCopiedSource(true)
      setTimeout(() => setCopiedSource(false), 1500)
    })
  }

  const handleCopyPath = (): void => {
    void copyToClipboard(filePath).then(() => {
      cue('success')
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1500)
    })
  }

  const handleReveal = (): void => {
    void revealFile(filePath)
  }

  const handleOpen = (): void => {
    void openFile(filePath)
  }

  const handleRestart = (): void => {
    void restartTask(task.id)
  }

  const handleRenew = (): void => {
    const url = renewURL.trim()
    if (!/^https?:\/\//i.test(url)) {
      setRenewError('请输入完整的 HTTP 或 HTTPS 下载链接')
      return
    }
    setRenewError(null)
    void renewTask(task.id, url)
      .then(() => {
        cue('success')
        setShowRenew(false)
      })
      .catch((error: unknown) => setRenewError(error instanceof Error ? error.message : '更新链接失败'))
  }

  const handleDelete = (deleteFile: boolean): void => {
    void remove(task.id, deleteFile)
    setShowDeleteConfirm(false)
    onClose()
  }

  return (
    <aside className="relative flex w-[320px] shrink-0 flex-col border-l border-line bg-panel">
      <span aria-hidden className="app-drag absolute inset-x-0 top-0 z-10 h-[44px]" />
      <div className="flex items-center justify-between px-5 pb-3 pt-[56px]">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">任务详情</div>
        <button
          type="button"
          data-cuelume-press="tick"
          onClick={onClose}
          className="rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6 scroll-quiet">
        <h2 className="font-serif text-[22px] leading-snug break-words">{task.filename || task.title}</h2>
        {isDistinctTitle(task.title, task.filename) ? (
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-mist">{task.title}</p>
        ) : task.source ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-mist">{task.source}</p>
        ) : null}

        {thumbnail ? (
          <figure className="media-thumbnail mt-3 overflow-hidden rounded-[12px] bg-ink/35">
            <div className="aspect-video">
              <img
                src={thumbnail}
                alt={`${task.title || task.filename} 的预览图`}
                className="h-full w-full object-cover"
                draggable={false}
              />
            </div>
          </figure>
        ) : null}

        <div className="mt-4 space-y-3">
          {sourceURL ? (
            <DetailValue
              label="来源网页"
              value={sourceURL}
              copied={copiedSource}
              onCopy={handleCopySource}
              onOpen={() => void openExternal(sourceURL)}
            />
          ) : null}
          <DetailValue
            label="下载链接"
            value={task.url}
            copied={copiedLink}
            onCopy={handleCopyLink}
            onOpen={() => void openExternal(task.url)}
          />
        </div>

        <dl className="mt-5 space-y-2.5 text-[12.5px]">
          <Fact label="状态" value={STATUS_LABEL[task.status]} />
          {task.phase ? <Fact label="阶段" value={PHASE_LABEL[task.phase]} /> : null}
          <Fact label="类型" value={CATEGORY_LABEL[task.category]} />
          {task.mediaOptions ? (
            <Fact label="成品格式" value={task.mediaOptions.container === 'compactMKV' ? 'MKV · 紧凑' : 'MP4 · 兼容'} />
          ) : null}
          {task.mediaOptions?.subtitleLanguage ? (
            <Fact label="字幕" value={task.mediaOptions.subtitleLanguage} />
          ) : null}
          <Fact label="大小" value={`${formatBytes(task.completedBytes)} / ${formatBytes(task.fileSize)}`} />
          <Fact label="进度" value={`${Math.round(fraction * 100)}%`} />
          {downloading ? (
            <Fact label="剩余时间" value={formatEta(remainingSeconds(task))} />
          ) : null}
          <Fact label="连接线程" value={`${task.connections} 个连接`} />
          {task.startAt ? <Fact label="定时开始" value={formatAppointment(task.startAt)} /> : null}
        </dl>
        <div className="mt-3 border-t border-line/60 pt-3">
          <DetailValue
            label="存储位置"
            value={filePath}
            copied={copiedPath}
            onCopy={handleCopyPath}
          />
        </div>

        {completed && completionArtifacts.length > 1 ? (
          <CompletionFiles
            artifacts={completionArtifacts}
            expanded={completionFilesExpanded}
            onToggle={() => setCompletionFilesExpanded((value) => !value)}
          />
        ) : null}

        {COMMERCIALIZATION_DRAFT_ENABLED ? (
          <div className="mt-5 space-y-2 border-t border-line/60 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">后期与同步</p>
            <ProRow
              icon={RefreshCcw}
              title="转换成其他格式"
              note="下载完成后直接转成 MP4 / MOV / GIF"
              locked={requiresPro('convert')}
              onClick={() => onUpgrade('格式转换与音频提取')}
            />
            <ProRow
              icon={Music}
              title="提取音轨"
              note="从视频中抽出 M4A，原文件保留"
              locked={requiresPro('convert')}
              onClick={() => onUpgrade('格式转换与音频提取')}
            />
            <ProRow
              icon={Cloud}
              title="历史云同步"
              note="这条记录在你的其他 Mac 上也能看到"
              locked={requiresPro('cloudHistory')}
              onClick={() => onUpgrade('下载历史云同步')}
            />
          </div>
        ) : null}

        {!completed ? (
          <div className="mt-5 space-y-3 border-t border-line/60 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist">调节</p>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12.5px] text-paper">连接数</div>
                <p className="mt-0.5 text-[10.5px] text-mist">确认能分段后按原版尽快加到这个上限</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mist hover:border-line-strong hover:text-paper"
                  onClick={() => void setTaskConnections(task.id, Math.max(1, task.connections - 1))}
                  aria-label="减少连接"
                >
                  <Minus size={12} />
                </button>
                <span className="w-6 text-center font-mono text-[12px] tabular-nums">{task.connections}</span>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mist hover:border-line-strong hover:text-paper"
                  onClick={() => void setTaskConnections(task.id, Math.min(32, task.connections + 1))}
                  aria-label="增加连接"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div>
              <div className="text-[12.5px] text-paper">此任务限速</div>
              <p className="mt-0.5 text-[10.5px] text-mist">不覆盖全局上限；正在传输的任务从下一轮开始生效</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { label: '不限速', val: 0 },
                  { label: '1 MB/s', val: 1_048_576 },
                  { label: '5 MB/s', val: 5_242_880 },
                  { label: '10 MB/s', val: 10_485_760 }
                ].map((tier) => {
                  const current = task.bandwidthLimit ?? 0
                  const active = current === tier.val
                  return (
                    <button
                      key={tier.label}
                      type="button"
                      onClick={() => void setTaskBandwidth(task.id, tier.val)}
                      className={`rounded-md px-2 py-1 text-[11px] ${
                        active
                          ? 'bg-copper text-on-accent'
                          : 'border border-line text-mist hover:border-line-strong hover:text-paper'
                      }`}
                    >
                      {tier.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <div className="text-[12.5px] text-paper">定时开始</div>
              <p className="mt-0.5 text-[10.5px] text-mist">到点会自动从等待变为下载</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-mist hover:text-paper"
                  onClick={() => void scheduleTask(task.id, Date.now() + 60 * 60 * 1000)}
                >
                  1 小时后
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-mist hover:text-paper"
                  onClick={() => void scheduleTask(task.id, tonightAt(23, 0))}
                >
                  今晚 23:00
                </button>
                {task.startAt ? (
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-1 text-[11px] text-clay hover:bg-clay/10"
                    onClick={() => void scheduleTask(task.id, null)}
                  >
                    清除预约
                  </button>
                ) : null}
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_auto] gap-1.5">
                <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] border border-line bg-panel/55 px-2 focus-within:border-copper/60">
                  <CalendarDays size={13} className="shrink-0 text-mist" />
                  <input
                    value={scheduleDate}
                    onChange={(event) => setScheduleDate(normalizeScheduleDate(event.target.value))}
                    inputMode="numeric"
                    placeholder="日/月/年"
                    aria-label="预约日期，日月年"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] tabular-nums text-paper outline-none placeholder:text-mist/60"
                  />
                </label>
                <label className="flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-panel/55 px-2 focus-within:border-copper/60">
                  <Clock3 size={13} className="shrink-0 text-mist" />
                  <input
                    value={scheduleTime}
                    onChange={(event) => setScheduleTime(normalizeScheduleTime(event.target.value))}
                    inputMode="numeric"
                    placeholder="时:分"
                    aria-label="预约时间，时和分"
                    className="w-full min-w-0 bg-transparent font-mono text-[11.5px] tabular-nums text-paper outline-none placeholder:text-mist/60"
                  />
                </label>
                <button
                  type="button"
                  disabled={customStartAt == null}
                  onClick={() => customStartAt != null && void scheduleTask(task.id, customStartAt)}
                  className="h-8 rounded-[8px] border border-line px-2.5 text-[11.5px] text-copper transition-[background-color,color,scale] duration-100 hover:bg-copper/10 active:scale-[0.96] disabled:cursor-default disabled:text-mist/45 disabled:hover:bg-transparent"
                >
                  预约
                </button>
              </div>
              <p className="mt-1.5 text-[10.5px] text-mist">日期按日／月／年填写，时间使用 24 小时制</p>
            </div>
          </div>
        ) : null}

        {failed && task.errorText ? (
          <div className="mt-4 rounded-lg border border-clay/30 bg-clay/10 px-3 py-2.5">
            <p className="text-[12px] font-medium text-clay">{task.diagnostic?.title || '下载失败'}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              {task.diagnostic?.message || task.errorText}
            </p>
            {showRenew ? (
              <div className="mt-2.5 border-t border-clay/20 pt-2.5">
                <input
                  autoFocus
                  value={renewURL}
                  onChange={(event) => {
                    setRenewURL(event.target.value)
                    setRenewError(null)
                  }}
                  className="w-full rounded-md border border-line-strong bg-ink/45 px-2 py-1.5 font-mono text-[10.5px] text-paper outline-none focus:border-copper/60"
                  aria-label="新的下载链接"
                  spellCheck={false}
                />
                {renewError ? <p className="mt-1 text-[10.5px] text-clay">{renewError}</p> : null}
                <div className="mt-2 flex justify-end gap-2 text-[11px]">
                  <button type="button" onClick={() => setShowRenew(false)} className="text-mist hover:text-paper">取消</button>
                  <button type="button" onClick={handleRenew} className="rounded-md bg-copper px-2.5 py-1 font-medium text-on-accent">更新并继续</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

      </div>

      {/* Delete confirmation dialog overlay */}
      {showDeleteConfirm ? (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-ink/75 p-4 backdrop-blur-sm">
          <div className="rounded-xl border border-line-strong bg-raised p-4 shadow-xl">
            <h4 className="text-[13px] font-medium text-paper">确定删除下载？</h4>
            <p className="mt-1 text-[11.5px] text-mist">您可以选择仅从列表中移除任务，或将已下载文件移到{TRASH_NAME}。</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => handleDelete(false)}
                className="w-full rounded-lg border border-line py-1.5 text-[12px] text-fog transition-colors hover:bg-line hover:text-paper"
              >
                仅从列表移除
              </button>
              <button
                type="button"
                onClick={() => handleDelete(true)}
                className="w-full rounded-lg bg-clay/15 py-1.5 text-[12px] font-medium text-clay transition-colors hover:bg-clay/25"
              >
                同时移到{TRASH_NAME}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="w-full py-1 text-[11.5px] text-mist hover:text-paper"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`grid ${completed ? (IS_WINDOWS ? 'grid-cols-4' : 'grid-cols-5') : 'grid-cols-3'} gap-1.5 border-t border-line p-3`}>
        {completed ? (
          <Action icon={Eye} label="预览" onClick={() => void quickLook(filePath)} />
        ) : failed ? (
          task.diagnostic?.primaryAction === 'openPage' && task.pageURL ? (
            <Action icon={ExternalLink} label="浏览器" onClick={() => void openExternal(task.pageURL!)} />
          ) : task.diagnostic?.primaryAction === 'renew' ? (
            <Action icon={RotateCw} label="更新" onClick={() => setShowRenew(true)} />
          ) : (
            <Action icon={RotateCw} label="重试" onClick={handleRestart} />
          )
        ) : (
          <Action
            icon={downloading ? Pause : Play}
            label={downloading ? '暂停' : '继续'}
            onClick={() => void toggle(task.id)}
          />
        )}
        <Action icon={FolderOpen} label={FILE_MANAGER} onClick={handleReveal} />
        {completed ? <Action icon={ExternalLink} label="打开" onClick={handleOpen} /> : null}
        {completed && !IS_WINDOWS ? <Action icon={Share2} label="分享" onClick={() => void shareFile(filePath)} /> : null}
        <Action icon={Trash2} label="删除" tone="danger" onClick={() => setShowDeleteConfirm(true)} />
      </div>
    </aside>
  )
}

function CompletionFiles({
  artifacts,
  expanded,
  onToggle
}: {
  artifacts: CompletionArtifact[]
  expanded: boolean
  onToggle: () => void
}) {
  const subtitleCount = artifacts.filter((artifact) => artifact.kind === 'subtitle').length
  const summary = [`${artifacts.length} 个文件`, subtitleCount > 0 ? `${subtitleCount} 份字幕` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="mt-5 border-t border-line/60 pt-4" aria-label="完成文件">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 rounded-[9px] py-1 text-left"
      >
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-paper">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          完成文件
        </span>
        <span className="text-[10.5px] text-mist">{summary}</span>
      </button>
      {expanded ? (
        <div
          className="mt-2 overflow-hidden rounded-[10px] border border-line/70"
          role="list"
          aria-label="完成文件列表"
        >
          {artifacts.map((artifact) => (
            <div
              key={artifact.path}
              role="listitem"
              className="flex min-h-11 items-center gap-2.5 border-b border-line/55 px-2.5 py-2 last:border-b-0"
            >
              <CompletionArtifactIcon kind={artifact.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] text-paper" title={artifact.name}>{artifact.name}</span>
                <span className="mt-0.5 block text-[10px] text-mist">
                  {completionArtifactLabel(artifact.kind)}{artifact.byteCount > 0 ? ` · ${formatBytes(artifact.byteCount)}` : ''}
                </span>
              </span>
              <button
                type="button"
                aria-label={`打开 ${artifact.name}`}
                title="打开"
                onClick={() => void openFile(artifact.path)}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] text-mist hover:bg-raised hover:text-paper"
              >
                <ExternalLink size={13} />
              </button>
              <button
                type="button"
                aria-label={`在${FILE_MANAGER}中显示 ${artifact.name}`}
                title={`在${FILE_MANAGER}中显示`}
                onClick={() => void revealFile(artifact.path)}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] text-mist hover:bg-raised hover:text-paper"
              >
                <FolderOpen size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CompletionArtifactIcon({ kind }: { kind: CompletionArtifact['kind'] }) {
  const className = 'shrink-0 text-copper'
  switch (kind) {
    case 'subtitle': return <Captions size={15} className={className} />
    case 'cover': return <ImageIcon size={15} className={className} />
    case 'audio': return <Music size={15} className={className} />
    case 'metadata': return <FileText size={15} className={className} />
    default: return <Play size={15} className={className} />
  }
}

function completionArtifactLabel(kind: CompletionArtifact['kind']): string {
  switch (kind) {
    case 'primary': return '主文件'
    case 'subtitle': return '字幕'
    case 'cover': return '封面'
    case 'audio': return '音频'
    case 'metadata': return '资料'
    case 'other': return '其他'
  }
}

function ProRow({
  icon: Icon,
  title,
  note,
  locked,
  onClick
}: {
  icon: typeof Music
  title: string
  note: string
  locked: boolean
  onClick: () => void
}) {
  const body = (
    <>
      <Icon size={13} strokeWidth={1.7} className="mt-[2px] shrink-0 text-copper" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[12.5px] text-paper">{title}</span>
          {locked ? <ProChip /> : null}
        </span>
        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-mist">
          {locked ? note : `${note} · 即将推出`}
        </span>
      </span>
    </>
  )

  if (!locked) {
    return <div className="flex items-start gap-2.5 rounded-lg border border-line px-2.5 py-2">{body}</div>
  }

  return (
    <button
      type="button"
      data-cuelume-press
      data-cuelume-release
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left transition-[border-color,background-color,scale] duration-150 hover:border-copper/40 hover:bg-raised active:scale-[0.98]"
    >
      {body}
    </button>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-mist">{label}</dt>
      <dd className="max-w-[190px] text-right font-mono text-[12.5px] leading-snug text-fog">{value}</dd>
    </div>
  )
}

function DetailValue({
  label,
  value,
  copied,
  onCopy,
  onOpen
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  onOpen?: () => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-mist">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="inline-flex items-center gap-1 text-[11.5px] text-mist transition-colors duration-100 hover:text-paper"
            >
              <ExternalLink size={12} />
              打开
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCopy}
            className={`inline-flex items-center gap-1 text-[11.5px] transition-colors duration-100 hover:text-paper ${copied ? 'text-sage' : 'text-copper'}`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      <div className="select-text break-all font-mono text-[11.5px] leading-relaxed text-fog" title={value}>
        {value}
      </div>
    </div>
  )
}

function Action({
  icon: Icon,
  label,
  onClick,
  tone
}: {
  icon: typeof Pause
  label: string
  onClick?: () => void
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      data-cuelume-press={tone === 'danger' ? 'droplet' : 'press'}
      data-cuelume-release
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1 rounded-lg border border-line py-2 text-[11px] transition-[color,background-color,border-color,scale] duration-150 active:scale-[0.96] hover:bg-raised ${
        tone === 'danger' ? 'text-clay hover:border-clay/40' : 'text-fog hover:text-paper'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatScheduleDate(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

function formatScheduleTime(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeScheduleDate(value: string): string {
  const cleaned = value.replace(/[^0-9/]/g, '').slice(0, 10)
  if (cleaned.includes('/')) return cleaned
  const digits = cleaned.replace(/\D/g, '')
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/')
}

function normalizeScheduleTime(value: string): string {
  const cleaned = value.replace(/[^0-9:]/g, '').slice(0, 5)
  if (cleaned.includes(':')) return cleaned
  const digits = cleaned.replace(/\D/g, '')
  return [digits.slice(0, 2), digits.slice(2, 4)].filter(Boolean).join(':')
}

function parseScheduleInput(dateValue: string, timeValue: string): number | null {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateValue)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue)
  if (!dateMatch || !timeMatch) return null
  const day = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const year = Number(dateMatch[3])
  const hours = Number(timeMatch[1])
  const minutes = Number(timeMatch[2])
  if (hours > 23 || minutes > 59) return null
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null
  return date.getTime()
}

function tonightAt(hours: number, minutes: number): number {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1)
  return date.getTime()
}

function formatAppointment(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
