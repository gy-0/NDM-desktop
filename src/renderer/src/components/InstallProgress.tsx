import { Check, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'

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
}

const PHASE_LABEL: Record<InstallProgressPhase, string> = {
  preparing: '准备安装',
  mounting: '正在挂载磁盘映像',
  scanning: '正在查找应用',
  copying: '正在安装到“应用程序”',
  finishing: '正在完成安装',
  waiting: '等待你的选择',
  complete: '已安装到“应用程序”',
  failed: '安装失败',
  cancelled: '已取消安装'
}

function displayName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.dmg$/i, '')
}

export function InstallProgress({
  progress,
  onDismiss
}: {
  progress: InstallProgressState | null
  onDismiss: () => void
}) {
  const reduceMotion = useReducedMotion()
  const terminal = progress?.phase === 'complete' || progress?.phase === 'failed' || progress?.phase === 'cancelled'
  const Icon = progress?.phase === 'complete' ? Check : progress?.phase === 'failed' ? TriangleAlert : LoaderCircle

  return progress ? (
        <motion.section
          role="status"
          aria-live="polite"
          initial={reduceMotion ? false : { opacity: 0, y: -7, filter: 'blur(3px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: reduceMotion ? 0.01 : 0.16, ease: 'easeOut' }}
          className="absolute right-6 top-[64px] z-40 w-[370px] rounded-xl border border-line-strong bg-raised p-3 shadow-[0_10px_24px_-18px_rgb(0_0_0/0.7)]"
          data-testid="install-progress"
        >
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 shrink-0 ${progress.phase === 'failed' ? 'text-clay' : progress.phase === 'complete' ? 'text-sage' : 'text-accent'}`}>
              <Icon size={17} strokeWidth={progress.phase === 'complete' ? 2 : 1.8} className={!terminal ? 'animate-spin' : undefined} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-[11px] font-medium text-fog">{PHASE_LABEL[progress.phase]}</div>
              <div className="truncate text-[13px] font-medium text-paper" title={progress.path}>
                {progress.appName ?? displayName(progress.path)}
              </div>
              {progress.detail ? (
                <div className="mt-0.5 truncate text-[10.5px] text-mist" title={progress.detail}>
                  {progress.detail}
                </div>
              ) : null}
            </div>
            {terminal ? (
              <button
                type="button"
                aria-label="关闭安装提示"
                onClick={onDismiss}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-mist transition-colors duration-100 hover:bg-panel hover:text-paper"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            ) : null}
          </div>

          {!terminal ? (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-panel">
              <motion.span
                className="block h-full w-2/5 rounded-full bg-accent"
                animate={reduceMotion ? undefined : { x: ['-120%', '270%'] }}
                transition={reduceMotion ? undefined : { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
          ) : null}
        </motion.section>
  ) : null
}
