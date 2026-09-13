import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference'

/** Measure natural content, while the outer flex item keeps its scroll limit. */
export function AnimatedHeight({ children, className, contentClassName }: {
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const height = useMotionValue(0)
  const reduced = useReducedMotionPreference()

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    let measured: number | undefined
    let playback: { stop: () => void } | undefined
    const resize = () => {
      // Layout coordinates exclude the popup's entrance scale.
      const next = content.offsetHeight
      if (measured !== undefined && Math.abs(next - measured) < .5) return
      playback?.stop()
      if (measured === undefined || reduced) height.set(next)
      else playback = animate(height, next, { duration: .22, ease: [0.22, 1, 0.36, 1] })
      measured = next
    }
    // The first size is set before paint; opening never grows from zero.
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(content)
    return () => { observer.disconnect(); playback?.stop() }
  }, [height, reduced])

  return <motion.div data-animated-height className={className} style={{ height }}>
    <div ref={contentRef} className={contentClassName} style={{ display: 'flow-root' }}>{children}</div>
  </motion.div>
}
