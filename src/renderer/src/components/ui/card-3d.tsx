import { cn } from '../../lib/cn'
import React, {
  createContext,
  useState,
  useContext,
  useRef,
  useEffect
} from 'react'

/**
 * Card3D — vendored from Aceternity UI (MIT, Manu Arora).
 * Original: https://ui.aceternity.com/components/3d-card
 * Adapted: TypeScript-strong context, no external deps. Wraps children in a
 * cursor-reactive 3D tilt using preserve-3d. Used for collection cards.
 */
const MouseEnterContext = createContext<
  [boolean, React.Dispatch<React.SetStateAction<boolean>>] | undefined
>(undefined)

export const CardContainer = ({
  children,
  className,
  containerClassName,
  intensity = 18
}: {
  children?: React.ReactNode
  className?: string
  containerClassName?: string
  intensity?: number
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isMouseEntered, setIsMouseEntered] = useState(false)

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return
    const { left, top, width, height } = containerRef.current.getBoundingClientRect()
    const x = ((e.clientX - left - width / 2) / 25) * (intensity / 18)
    const y = ((e.clientY - top - height / 2) / 25) * (intensity / 18)
    containerRef.current.style.transform = `rotateY(${x}deg) rotateX(${y}deg)`
  }

  const handleMouseEnter = () => setIsMouseEntered(true)
  const handleMouseLeave = () => {
    if (!containerRef.current) return
    setIsMouseEntered(false)
    containerRef.current.style.transform = `rotateY(0deg) rotateX(0deg)`
  }

  return (
    <MouseEnterContext.Provider value={[isMouseEntered, setIsMouseEntered]}>
      <div
        className={cn('[perspective:1400px]', containerClassName)}
        style={{ perspective: '1400px' }}
      >
        <div
          ref={containerRef}
          onMouseEnter={handleMouseEnter}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className={cn(
            'flex flex-col transition-transform duration-200 ease-bui [transform-style:preserve-3d]',
            className
          )}
          style={{ transformStyle: 'preserve-3d' }}
        >
          {children}
        </div>
      </div>
    </MouseEnterContext.Provider>
  )
}

export const CardBody = ({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}) => (
  <div
    className={cn('[transform-style:preserve-3d]', className)}
    style={{ transformStyle: 'preserve-3d' }}
  >
    {children}
  </div>
)

export const CardItem = ({
  as: Tag = 'div',
  children,
  className,
  translateX = 0,
  translateY = 0,
  translateZ = 0,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  ...rest
}: {
  as?: React.ElementType
  children: React.ReactNode
  className?: string
  translateX?: number | string
  translateY?: number | string
  translateZ?: number | string
  rotateX?: number | string
  rotateY?: number | string
  rotateZ?: number | string
  [key: string]: unknown
}) => {
  const ref = useRef<HTMLElement>(null)
  const [isMouseEntered] = useMouseEnter()

  useEffect(() => {
    handleAnimations()
  }, [isMouseEntered])

  const handleAnimations = () => {
    if (!ref.current) return
    if (isMouseEntered) {
      ref.current.style.transform = `translateX(${translateX}px) translateY(${translateY}px) translateZ(${translateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg)`
    } else {
      ref.current.style.transform = `translateX(0px) translateY(0px) translateZ(0px) rotateX(0deg) rotateY(0deg) rotateZ(0deg)`
    }
  }

  const Component = Tag as React.ElementType
  return (
    <Component
      ref={ref}
      className={cn('transition-transform duration-200 ease-bui', className)}
      {...rest}
    >
      {children}
    </Component>
  )
}

export const useMouseEnter = () => {
  const context = useContext(MouseEnterContext)
  if (context === undefined) {
    throw new Error('useMouseEnter must be used within a MouseEnterProvider')
  }
  return context
}
