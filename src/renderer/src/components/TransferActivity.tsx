import { ArrowUpRight, Check, FolderOpen, PackageOpen, Play, RotateCw, TriangleAlert, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { formatBytes, isDiskImageFile } from '../lib/format'
import { openFile, revealFile } from '../lib/store'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import './ui/transfer-activity.css'

export type CompletionNotice = {
  id: number
  title: string
  filename: string
  folderPath: string
  fullPath: string
  byteCount?: number
}

export type InstallProgressPhase =
  | 'preparing'
  | 'mounting'
  | 'scanning'
  | 'copying'
  | 'finishing'
  | 'waiting'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type InstallProgressState = {
  id: number
  path: string
  phase: InstallProgressPhase
  appName?: string
  detail?: string
  installedPath?: string
  appIcon?: string
}

const INSTALL_LABEL: Record<InstallProgressPhase, string> = {
  preparing: '准备安装',
  mounting: '正在挂载磁盘映像',
  scanning: '正在查找应用',
  copying: '正在安装到“应用程序”',
  finishing: '正在完成安装',
  waiting: '等待你的选择',
  complete: '安装完成',
  failed: '安装失败',
  cancelled: '安装已取消'
}

export function TransferActivity({
  notice,
  progress,
  onOpen,
  onReveal,
  onRetryInstall,
  onDismissNotice,
  onDismissProgress
}: {
  notice: CompletionNotice | null
  progress: InstallProgressState | null
  onOpen: (notice: CompletionNotice) => Promise<string>
  onReveal: (notice: CompletionNotice) => void
  onRetryInstall: (progress: InstallProgressState) => Promise<string>
  onDismissNotice: () => void
  onDismissProgress: () => void
}) {
  const reduceMotion = useReducedMotion()
  const [opening, setOpening] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [actionError, setActionError] = useState('')
  const completedSource = useRef<CompletionNotice | null>(null)
  const actionGeneration = useRef(0)
  const actionPending = useRef(false)
  const activityPath = progress?.path ?? notice?.fullPath
  const activityID = progress?.id ?? notice?.id
  const source = notice?.fullPath === activityPath ? notice
    : completedSource.current?.fullPath === activityPath ? completedSource.current : null
  const filename = source?.filename || activityPath?.split(/[\\/]/).pop() || ''
  const byteCount = source?.byteCount
  const size = byteCount != null && Number.isFinite(byteCount) && byteCount >= 0 ? formatBytes(byteCount) : null

  useEffect(() => {
    // A different completed download can wait behind this installation. Keep
    // the current package's confirmed metadata until its own surface yields.
    if (!activityPath) completedSource.current = null
    else if (notice && (!progress || notice.fullPath === progress.path)) completedSource.current = notice
  }, [notice, progress?.path, activityPath])

  useEffect(() => {
    actionGeneration.current++
    actionPending.current = false
    setOpening(false)
    setRetrying(false)
    setActionError('')
  }, [activityPath, activityID, progress?.phase])

  useEffect(() => () => { actionGeneration.current++ }, [])

  const installsApp = Boolean(notice && !IS_WINDOWS && isDiskImageFile(notice.fullPath))
  const terminal = progress?.phase === 'complete' || progress?.phase === 'failed' || progress?.phase === 'cancelled'
  const activeInstall = Boolean(progress && !terminal)

  const startCompletionAction = async (): Promise<void> => {
    if (!notice || actionPending.current) return
    actionPending.current = true
    const generation = ++actionGeneration.current
    setOpening(true)
    setActionError('')
    try {
      const result = await onOpen(notice)
      if (generation !== actionGeneration.current) return
      if (result) setActionError(result)
      else if (!installsApp) onDismissNotice()
    } catch {
      if (generation === actionGeneration.current) setActionError(installsApp ? '未能开始安装，请重试。' : '无法打开文件，请重试。')
    } finally {
      if (generation === actionGeneration.current) { actionPending.current = false; setOpening(false) }
    }
  }

  const retryInstall = async (): Promise<void> => {
    if (!progress || actionPending.current) return
    actionPending.current = true
    const generation = ++actionGeneration.current
    setRetrying(true)
    setActionError('')
    try {
      const result = await onRetryInstall(progress)
      if (generation !== actionGeneration.current) return
      if (result) setActionError(result)
    } catch {
      if (generation === actionGeneration.current) setActionError('未能重新安装，请重试。')
    } finally {
      if (generation === actionGeneration.current) { actionPending.current = false; setRetrying(false) }
    }
  }

  const openInstalledApp = async (): Promise<void> => {
    if (!progress?.installedPath || actionPending.current) return
    actionPending.current = true
    const generation = ++actionGeneration.current
    setOpening(true)
    setActionError('')
    try {
      const error = await openFile(progress.installedPath)
      if (generation !== actionGeneration.current) return
      if (error) setActionError(error)
      else onDismissProgress()
    } catch {
      if (generation === actionGeneration.current) setActionError('暂时无法打开应用，请重试。')
    } finally {
      if (generation === actionGeneration.current) { actionPending.current = false; setOpening(false) }
    }
  }

  const detail = actionError || (progress && ['failed', 'cancelled', 'waiting'].includes(progress.phase) ? progress.detail : '')
  const status = progress ? INSTALL_LABEL[progress.phase]
    : actionError ? (installsApp ? '安装未开始' : '文件无法打开') : '下载完成'

  return (
    <AnimatePresence initial={false}>
      {activityPath ? (
        <motion.section
          key={activityPath}
          role="status"
          aria-live="polite"
          layout
          initial={reduceMotion ? false : { opacity: 0, y: -8, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, filter: 'blur(3px)' }}
          transition={{ duration: reduceMotion ? 0.01 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="transfer-activity transfer-activity-compact"
          data-testid={progress ? 'install-progress' : 'completion-bar'}
          data-activity-path={activityPath}
          data-activity-phase={progress?.phase ?? 'downloaded'}
        >
          <div className="transfer-activity-summary">
            <ActivityIcon progress={progress} />

            <div className="transfer-activity-identity">
              <div data-activity-filename className="transfer-activity-filename" title={filename}>{filename}</div>
              <div className="transfer-activity-meta">
                <span data-activity-status>{status}</span>
                {size ? <><span aria-hidden>·</span><span data-activity-size title="下载文件大小">{size}</span></> : null}
              </div>
            </div>

            {!activeInstall ? (
              <button
                type="button"
                aria-label={progress ? '关闭安装提示' : '关闭完成提示'}
                onClick={progress ? onDismissProgress : onDismissNotice}
                className="transfer-activity-close"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            ) : null}
          </div>

          {detail ? <p data-activity-detail className="transfer-activity-detail" data-error={Boolean(actionError) || progress?.phase === 'failed' || undefined}>{detail}</p> : null}

          {activeInstall ? (
            <div data-install-indicator role="progressbar" aria-label={status} className="transfer-activity-indicator">
              {!reduceMotion && progress?.phase !== 'waiting' ? <motion.span
                animate={{ x: ['-120%', '360%'] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              /> : null}
            </div>
          ) : (
            <div className="transfer-activity-actions">
              {progress?.phase === 'complete' && progress.installedPath ? (
                <>
                  <SecondaryAction
                    icon={FolderOpen}
                    label={`在${FILE_MANAGER}中显示`}
                    onClick={() => {
                      void revealFile(progress.installedPath!)
                      onDismissProgress()
                    }}
                  />
                  <PrimaryAction
                    icon={ArrowUpRight}
                    label={opening ? '正在打开' : '打开应用'}
                    disabled={opening}
                    onClick={() => void openInstalledApp()}
                  />
                </>
              ) : progress?.phase === 'failed' ? (
                <>
                  <SecondaryAction icon={FolderOpen} label={`在${FILE_MANAGER}中显示`} onClick={() => void revealFile(progress.path)} />
                  <PrimaryAction icon={RotateCw} label={retrying ? '重试中' : '重试安装'} disabled={retrying} onClick={() => void retryInstall()} />
                </>
              ) : progress?.phase === 'cancelled' ? (
                <>
                  <SecondaryAction icon={FolderOpen} label={`在${FILE_MANAGER}中显示`} onClick={() => void revealFile(progress.path)} />
                  <PrimaryAction icon={RotateCw} label={retrying ? '准备安装' : '重新安装'} disabled={retrying} onClick={() => void retryInstall()} />
                </>
              ) : !progress && notice ? (
                <>
                  <SecondaryAction
                    icon={FolderOpen}
                    label={`在${FILE_MANAGER}中显示`}
                    onClick={() => {
                      onReveal(notice)
                      onDismissNotice()
                    }}
                  />
                  <PrimaryAction
                    icon={installsApp ? PackageOpen : Play}
                    label={opening ? (installsApp ? '准备安装' : '正在打开') : actionError ? '重试' : installsApp ? '安装到应用程序' : '打开文件'}
                    disabled={opening}
                    onClick={() => void startCompletionAction()}
                  />
                </>
              ) : null}
            </div>
          )}
        </motion.section>
      ) : null}
    </AnimatePresence>
  )
}

function ActivityIcon({ progress }: { progress: InstallProgressState | null }) {
  if (progress?.phase === 'complete' && progress.appIcon) {
    return (
      <div className="transfer-activity-icon" data-app-icon>
        <img src={progress.appIcon} alt="" draggable={false} />
      </div>
    )
  }

  const failed = progress?.phase === 'failed'
  const cancelled = progress?.phase === 'cancelled'
  const complete = progress?.phase === 'complete'
  const Icon = failed ? TriangleAlert : cancelled ? X : complete ? Check : progress ? PackageOpen : Check
  return (
    <div className="transfer-activity-icon" data-failed={failed || undefined}>
      <Icon size={19} strokeWidth={1.7} aria-hidden />
    </div>
  )
}

function SecondaryAction({ icon: Icon, label, onClick }: { icon: typeof FolderOpen; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transfer-activity-button"
    >
      <Icon size={14} strokeWidth={1.6} aria-hidden />
      {label}
    </button>
  )
}

function PrimaryAction({ icon: Icon, label, onClick, disabled = false }: { icon: typeof PackageOpen; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={disabled || undefined}
      onClick={onClick}
      className="transfer-activity-button transfer-activity-primary"
    >
      <Icon size={14} strokeWidth={1.7} aria-hidden />
      {label}
    </button>
  )
}
