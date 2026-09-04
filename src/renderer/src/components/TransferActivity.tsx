import { ArrowUpRight, Check, FolderOpen, PackageOpen, Play, RotateCw, TriangleAlert, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { isDiskImageFile } from '../lib/format'
import { openFile, revealFile } from '../lib/store'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'

export type CompletionNotice = {
  id: number
  title: string
  filename: string
  folderPath: string
  fullPath: string
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

function displayName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.dmg$/i, '')
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
  const activityPath = progress?.path ?? notice?.fullPath

  useEffect(() => {
    setOpening(false)
    setRetrying(false)
    setActionError('')
  }, [activityPath, progress?.phase])

  const installsApp = Boolean(notice && !IS_WINDOWS && isDiskImageFile(notice.fullPath))
  const terminal = progress?.phase === 'complete' || progress?.phase === 'failed' || progress?.phase === 'cancelled'
  const activeInstall = Boolean(progress && !terminal)

  const startCompletionAction = async (): Promise<void> => {
    if (!notice || opening) return
    setOpening(true)
    setActionError('')
    try {
      const result = await onOpen(notice)
      if (result) setActionError(result)
      else if (!installsApp) onDismissNotice()
    } catch {
      setActionError(installsApp ? '安装没有开始，请重试。' : '无法打开文件，请重试。')
    } finally {
      setOpening(false)
    }
  }

  const retryInstall = async (): Promise<void> => {
    if (!progress || retrying) return
    setRetrying(true)
    setActionError('')
    try {
      const result = await onRetryInstall(progress)
      if (result) setActionError(result)
    } catch {
      setActionError('安装没有重新开始，请重试。')
    } finally {
      setRetrying(false)
    }
  }

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
          className="absolute right-6 top-[64px] z-40 w-[390px] overflow-hidden rounded-[14px] border border-line-strong bg-raised/96 p-3.5 shadow-[0_16px_36px_-18px_rgb(0_0_0/0.72)] backdrop-blur-xl"
          data-testid={progress ? 'install-progress' : 'completion-bar'}
          data-activity-path={activityPath}
          data-activity-phase={progress?.phase ?? 'downloaded'}
        >
          <div className="flex items-start gap-3">
            <ActivityIcon progress={progress} />

            <div className="min-w-0 flex-1 pt-0.5">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={progress?.phase ?? 'downloaded'}
                  initial={reduceMotion ? false : { opacity: 0, y: 3, filter: 'blur(2px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -2, filter: 'blur(2px)' }}
                  transition={{ duration: reduceMotion ? 0.01 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className={`text-[11px] font-medium ${progress?.phase === 'failed' ? 'text-clay' : progress?.phase === 'complete' ? 'text-sage' : 'text-fog'}`}>
                    {progress ? INSTALL_LABEL[progress.phase] : actionError ? (installsApp ? '安装未开始' : '文件无法打开') : '下载完成'}
                  </div>
                  <div className="truncate text-[13px] font-medium text-paper" title={activityPath}>
                    {progress?.appName ?? (progress ? displayName(progress.path) : notice?.filename)}
                  </div>
                  <div className={`mt-0.5 truncate text-[10.5px] ${actionError ? 'text-clay' : 'text-mist'}`} title={actionError || progress?.detail || notice?.folderPath}>
                    {actionError || progress?.detail || notice?.folderPath}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            {!activeInstall ? (
              <button
                type="button"
                aria-label={progress ? '关闭安装提示' : '关闭完成提示'}
                onClick={progress ? onDismissProgress : onDismissNotice}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-mist transition-[background-color,color,scale] duration-100 hover:bg-panel hover:text-paper active:scale-[0.96]"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            ) : null}
          </div>

          {activeInstall ? (
            <div data-install-indicator className="mt-3 h-1 overflow-hidden rounded-full bg-panel">
              <motion.span
                className="block h-full w-2/5 rounded-full bg-accent"
                animate={reduceMotion ? undefined : { x: ['-120%', '270%'] }}
                transition={reduceMotion ? undefined : { duration: 1.15, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-end gap-1.5">
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
                    label="打开应用"
                    onClick={() => {
                      void openFile(progress.installedPath!)
                      onDismissProgress()
                    }}
                  />
                </>
              ) : progress?.phase === 'failed' ? (
                <>
                  <SecondaryAction icon={FolderOpen} label={`在${FILE_MANAGER}中显示`} onClick={() => void revealFile(progress.path)} />
                  <PrimaryAction icon={RotateCw} label={retrying ? '重试中' : '重试安装'} disabled={retrying} onClick={() => void retryInstall()} />
                </>
              ) : progress?.phase === 'cancelled' ? (
                <SecondaryAction icon={FolderOpen} label={`在${FILE_MANAGER}中显示`} onClick={() => void revealFile(progress.path)} />
              ) : notice ? (
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
      <div className="relative size-9 shrink-0">
        <img src={progress.appIcon} alt="" className="size-9 object-contain" draggable={false} />
        <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-sage text-ink shadow-[0_0_0_2px_var(--raised)]">
          <Check size={10} strokeWidth={2.4} />
        </span>
      </div>
    )
  }

  const failed = progress?.phase === 'failed'
  const cancelled = progress?.phase === 'cancelled'
  const complete = progress?.phase === 'complete'
  const Icon = failed ? TriangleAlert : cancelled ? X : complete ? Check : progress ? PackageOpen : Check
  return (
    <div className={`grid size-9 shrink-0 place-items-center rounded-[10px] border ${failed ? 'border-clay/25 bg-clay/10 text-clay' : complete ? 'border-sage/25 bg-sage/10 text-sage' : 'border-line bg-panel/70 text-accent'}`}>
      <Icon size={17} strokeWidth={failed ? 1.8 : 2} />
    </div>
  )
}

function SecondaryAction({ icon: Icon, label, onClick }: { icon: typeof FolderOpen; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11.5px] text-fog transition-[background-color,color,scale] duration-100 hover:bg-panel hover:text-paper active:scale-[0.96]"
    >
      <Icon size={13} strokeWidth={1.6} />
      {label}
    </button>
  )
}

function PrimaryAction({ icon: Icon, label, onClick, disabled = false }: { icon: typeof PackageOpen; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-[background-color,opacity,scale] duration-100 hover:bg-paper active:scale-[0.96] disabled:cursor-wait disabled:opacity-60"
    >
      <Icon size={13} strokeWidth={1.7} />
      {label}
    </button>
  )
}
