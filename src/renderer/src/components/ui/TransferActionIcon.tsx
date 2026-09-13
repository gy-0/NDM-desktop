import { ArrowDownToLine, LoaderCircle, Pause, Play } from 'lucide-react'
import { motion } from 'motion/react'
import { memo } from 'react'
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference'

export type TransferActionIconState = 'play' | 'pause' | 'download' | 'pending'

const ICONS = { play: Play, pause: Pause, download: ArrowDownToLine, pending: LoaderCircle }
const STATES = ['play', 'pause', 'download', 'pending'] as const

/** Decorative only: the owning button supplies its action name and busy state. */
export const TransferActionIcon = memo(function TransferActionIcon({
  state,
  size = 13,
  className = ''
}: {
  state: TransferActionIconState
  size?: number
  className?: string
}) {
  const reduced = useReducedMotionPreference()
  const CurrentIcon = ICONS[state]

  return (
    <span
      data-transfer-action-icon={state}
      aria-hidden
      className={`pointer-events-none relative inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {reduced ? <CurrentIcon size={size} /> : STATES.map((item) => {
        const Icon = ICONS[item]
        const visible = item === state
        return (
          <motion.span
            key={item}
            className="absolute inset-0 inline-flex"
            initial={false}
            animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 2, scale: visible ? 1 : .85 }}
            transition={{ duration: .15, ease: 'easeOut' }}
          >
            {/* Keep action layers mounted so a new state retargets the current
                transition. An idle control never keeps a hidden spinner alive. */}
            {item !== 'pending' || visible
              ? <Icon size={size} className={item === 'pending' ? 'animate-spin' : undefined} />
              : null}
          </motion.span>
        )
      })}
    </span>
  )
})
