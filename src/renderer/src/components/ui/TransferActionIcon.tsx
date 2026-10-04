import { ArrowDownToLine, LoaderCircle, Pause, Play } from 'lucide-react'
import { memo } from 'react'

export type TransferActionIconState = 'play' | 'pause' | 'download' | 'pending'
const ICONS = { play: Play, pause: Pause, download: ArrowDownToLine, pending: LoaderCircle }

/** A single decorative glyph prevents a paused action resembling two symbols. */
export const TransferActionIcon = memo(function TransferActionIcon({ state, size = 13, className = '' }: {
  state: TransferActionIconState
  size?: number
  className?: string
}) {
  const Icon = ICONS[state]
  return <span data-transfer-action-icon={state} aria-hidden className={`pointer-events-none inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
    <Icon size={size} className={state === 'pending' ? 'animate-spin motion-reduce:animate-none' : undefined} />
  </span>
})
