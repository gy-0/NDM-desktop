import { cn } from '../../lib/cn'
import { useMotionTemplate, useMotionValue, motion } from 'motion/react'
import React, { MouseEvent as ReactMouseEvent, useState } from 'react'

/**
 * CardSpotlight — vendored and recolored from Aceternity UI (MIT, Manu Arora).
 * Original: https://ui.aceternity.com/components/card-spotlight
 * Adapted: copper accent (var(--accent)) instead of the default neutral, so it
 * stays inside NDM's walnut/copper design language.
 */
export const CardSpotlight = ({
  children,
  radius = 320,
  color = 'var(--accent)',
  className,
  ...props
}: {
  radius?: number
  color?: string
  children: React.ReactNode
} & React.HTMLAttributes<HTMLDivElement>) => {
  const mouseX = useMotionValue(0)
  const mouseY = useMotionValue(0)
  const background = useMotionTemplate`radial-gradient(${radius}px circle at ${mouseX}px ${mouseY}px, ${color}, transparent 70%)`

  function handleMouseMove({ currentTarget, clientX, clientY }: ReactMouseEvent<HTMLDivElement>) {
    const { left, top } = currentTarget.getBoundingClientRect()
    mouseX.set(clientX - left)
    mouseY.set(clientY - top)
  }

  const [isHovering, setIsHovering] = useState(false)

  return (
    <div
      className={cn('group/spotlight relative overflow-hidden', className)}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      {...props}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
        style={{ background, opacity: isHovering ? 1 : 0 }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  )
}
