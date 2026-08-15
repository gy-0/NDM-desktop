import { Check, Copy, ExternalLink, Eye, FolderOpen, Pause, Play, RotateCw, Share2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { formatBytes, formatEta, fractionOf, remainingSeconds } from '../lib/format'
import { copyToClipboard, openExternal, openFile, quickLook, remove, renewTask, restartTask, revealFile, shareFile, toggle } from '../lib/store'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type Task } from '../lib/types'
import { cue } from '../lib/sound'
import { useTaskThumbnail } from '../lib/taskThumbnail'

export function Inspector({ task, onClose }: { task: Task; onClose: () => void }) {
  const fraction = fractionOf(task)
  const completed = task.status === 'complete'
  const downloading = task.status === 'downloading'
  const failed = task.status === 'error'
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRenew, setShowRenew] = useState(false)
  const [renewURL, setRenewURL] = useState(task.url)
  const [renewError, setRenewError] = useState<string | null>(null)
  const thumbnail = useTaskThumbnail(task)

  const filePath = task.folderPath
    ? task.folderPath.endsWith('/')
      ? `${task.folderPath}${task.filename}`
      : `${task.folderPath}/${task.filename}`
    : task.filename

  const handleCopyLink = (): void => {
    void copyToClipboard(task.url).then(() => {
      cue('success')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
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
        {task.title && task.title !== task.filename ? (
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-mist">{task.title}</p>
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

        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-lg border border-line bg-ink/30 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist" title={task.url}>
            {task.url}
          </p>
          <button
            type="button"
            onClick={handleCopyLink}
            className="flex shrink-0 items-center gap-1 text-[11px] text-copper transition-colors hover:text-paper"
          >
            {copied ? (
              <>
                <Check size={12} className="text-sage" />
                <span className="text-sage">已复制</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>复制</span>
              </>
            )}
          </button>
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
          {task.source ? <Fact label="来源主机" value={task.source} /> : null}
          <div className="flex flex-col gap-1 border-t border-line/60 pt-2 text-[12px]">
            <dt className="flex items-center justify-between text-mist">
              <span>存储位置</span>
              <button
                type="button"
                onClick={handleCopyPath}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-copper transition-[color,background-color] duration-75 hover:bg-line hover:text-paper"
              >
                {copiedPath ? <Check size={11} className="text-sage" /> : <Copy size={11} />}
                <span className={copiedPath ? 'text-sage' : ''}>{copiedPath ? '已复制' : '复制路径'}</span>
              </button>
            </dt>
            <dd className="select-text break-all font-mono text-[11px] text-fog">{filePath}</dd>
          </div>
        </dl>

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
            <p className="mt-1 text-[11.5px] text-mist">您可以选择仅从列表中移除任务，或将已下载文件移到废纸篓。</p>
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
                同时移到废纸篓
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

      <div className={`grid ${completed ? 'grid-cols-5' : 'grid-cols-4'} gap-1.5 border-t border-line p-3`}>
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
        <Action icon={FolderOpen} label="访达" onClick={handleReveal} />
        {completed ? (
          <Action icon={ExternalLink} label="打开" onClick={handleOpen} />
        ) : (
          <Action icon={RotateCw} label="重下" onClick={handleRestart} />
        )}
        {completed ? <Action icon={Share2} label="分享" onClick={() => void shareFile(filePath)} /> : null}
        <Action icon={Trash2} label="删除" tone="danger" onClick={() => setShowDeleteConfirm(true)} />
      </div>
    </aside>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-mist">{label}</dt>
      <dd className="max-w-[190px] text-right font-mono text-[12px] leading-snug text-fog">{value}</dd>
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
