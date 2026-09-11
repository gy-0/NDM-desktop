import { motion, useReducedMotion } from 'motion/react'
import { Check, Copy } from 'lucide-react'

// Fixed icon/label slots adapted from Opensource UI's MIT copy-button.
// State comes only from NDM's acknowledged clipboard operation.
export function CopyFeedbackIcon({ copied, size = 12 }: { copied: boolean; size?: number }) {
  const reduced = useReducedMotion()
  const icon = (visible: boolean) => ({ opacity: visible ? 1 : 0, scale: visible || reduced ? 1 : .25, filter: visible || reduced ? 'blur(0px)' : 'blur(4px)' })
  const transition = reduced ? { duration: 0 } : { type: 'spring' as const, duration: .3, bounce: 0 }
  return (
    <span className="copy-feedback-icon" data-copy-animation aria-hidden style={{width: size, height: size}}>
      <motion.span data-copy-icon="idle" initial={false} animate={icon(!copied)} transition={transition}><Copy size={size} /></motion.span>
      <motion.span data-copy-icon="done" initial={false} animate={icon(copied)} transition={transition}><Check size={size} /></motion.span>
    </span>
  )
}

export function CopyFeedback({ copied, error, onCopy, label = '复制' }: { copied: boolean; error?: string; onCopy: () => void; label?: string }) {
  return (
    <span className="copy-feedback" data-copied={copied} data-error={Boolean(error)}>
      <button type="button" onClick={onCopy} aria-label={copied ? '已复制' : error ? '重试复制' : label} className="ndm-control copy-feedback-button">
        <CopyFeedbackIcon copied={copied} />
        <span className="copy-feedback-label" aria-hidden>
          <span data-copy-idle>{label}</span>
          <span data-copy-done>已复制</span>
        </span>
      </button>
      <span role="status" className={error ? 'copy-feedback-error' : 'sr-only'}>{error || (copied ? '已复制' : '')}</span>
    </span>
  )
}
