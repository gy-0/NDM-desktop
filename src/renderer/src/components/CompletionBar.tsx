import { Check, FolderOpen, Play, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FILE_MANAGER } from '../lib/platform'

export type CompletionNotice = {
  id: number
  title: string
  filename: string
  folderPath: string
  fullPath: string
}

export function CompletionBar({
  notice,
  onOpen,
  onReveal,
  onDismiss
}: {
  notice: CompletionNotice | null
  onOpen: (notice: CompletionNotice) => void
  onReveal: (notice: CompletionNotice) => void
  onDismiss: () => void
}) {
  const reduceMotion = useReducedMotion()

  return (
    <AnimatePresence initial={false}>
      {notice ? (
        <motion.section
          key={notice.id}
          role="status"
          aria-live="polite"
          initial={reduceMotion ? false : { opacity: 0, y: -8, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, filter: 'blur(3px)' }}
          transition={{ duration: reduceMotion ? 0.01 : 0.18, ease: 'easeOut' }}
          className="absolute right-6 top-[64px] z-40 w-[370px] rounded-xl border border-line-strong bg-raised p-3 shadow-[0_12px_28px_-16px_rgb(0_0_0/0.68)]"
          data-testid="completion-bar"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 text-sage">
              <Check size={17} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-[11px] font-medium text-fog">下载完成</div>
              <div className="truncate text-[13px] font-medium text-paper" title={notice.filename}>
                {notice.filename}
              </div>
              {notice.folderPath ? (
                <div className="mt-0.5 truncate font-mono text-[10.5px] text-mist" title={notice.folderPath}>
                  {notice.folderPath}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="关闭完成提示"
              onClick={onDismiss}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-mist transition-colors duration-100 hover:bg-panel hover:text-paper"
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onReveal(notice)}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11.5px] text-fog transition-colors duration-100 hover:bg-panel"
            >
              <FolderOpen size={13} strokeWidth={1.5} />
              在{FILE_MANAGER}中显示
            </button>
            <button
              type="button"
              onClick={() => onOpen(notice)}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-colors duration-100 hover:bg-paper"
            >
              <Play size={12} fill="currentColor" strokeWidth={1.5} />
              打开文件
            </button>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  )
}
