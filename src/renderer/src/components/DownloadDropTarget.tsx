import { ArrowDownToLine } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { RefObject } from 'react'
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference'
import './ui/download-drop-target.css'

export function DownloadDropTarget({ active, hot, targetRef }: {
  active: boolean
  hot: boolean
  targetRef: RefObject<HTMLDivElement | null>
}) {
  const reduced = useReducedMotionPreference()
  return <AnimatePresence>
    {active ? <motion.div key="download-drop-target" data-download-drop-target
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : .16, ease: 'easeOut' }}
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink/92">
      <div ref={targetRef} data-drop-card data-drop-hot={hot || undefined}
        className="download-drop-card relative flex w-[min(460px,calc(100%-48px))] items-start gap-4 rounded-surface border border-line-strong bg-raised px-6 py-5 shadow-dialog">
        <span className="download-drop-symbol" aria-hidden>
          <svg className="download-drop-outline" viewBox="0 0 44 44" fill="none">
            <rect x="1" y="1" width="42" height="42" rx="11" stroke="currentColor" strokeWidth="1" strokeDasharray="3 4" />
          </svg>
          <ArrowDownToLine size={20} strokeWidth={1.7} className="download-drop-arrow" />
        </span>
        <div className="min-w-0">
          <div className="text-title font-semibold leading-tight text-paper">释放以检查下载</div>
          <p className="mt-1.5 text-meta leading-relaxed text-mist">支持网页、文件直链、媒体链接和磁力链；确认后再开始</p>
        </div>
      </div>
    </motion.div> : null}
  </AnimatePresence>
}
