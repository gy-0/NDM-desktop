import { ChevronRight } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import './animated-disclosure.css'

/** Native disclosure semantics, with an interruptible intrinsic-height reveal. */
export function AnimatedDisclosure({
  summary,
  children,
  trailing,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  summaryClassName,
  contentClassName
}: {
  summary: ReactNode
  children: ReactNode
  trailing?: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  summaryClassName?: string
  contentClassName?: string
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const expanded = open ?? localOpen
  const panelId = useId()
  const changeOpen = (next: boolean): void => {
    if (open === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }

  return (
    <details
      className={cn('animated-disclosure', className)}
      open={expanded}
      onToggle={(event) => {
        // Also follow native opening, such as a browser find-in-page result.
        if (event.currentTarget.open !== expanded) changeOpen(event.currentTarget.open)
      }}
    >
      <summary
        className={cn('animated-disclosure-summary', summaryClassName)}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={(event) => {
          // Enter and Space still use the summary's native click activation.
          // Commit inert together with open, before the closing pixels leave.
          event.preventDefault()
          changeOpen(!expanded)
        }}
      >
        <ChevronRight size={13} aria-hidden className="animated-disclosure-chevron" />
        <span className="min-w-0 flex-1">{summary}</span>
        {trailing}
      </summary>
      <div id={panelId} inert={!expanded} aria-hidden={!expanded || undefined}
        className={cn('animated-disclosure-content', contentClassName)}>
        {children}
      </div>
    </details>
  )
}
