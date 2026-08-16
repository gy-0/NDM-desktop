import type { ReactNode } from 'react'
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react'
import type {
  GlobalOptions as ConfettiGlobalOptions,
  CreateTypes as ConfettiInstance,
  Options as ConfettiOptions
} from 'canvas-confetti'
import confetti from 'canvas-confetti'

export type ConfettiRef = {
  fire: (options?: ConfettiOptions) => Promise<void> | void
}

type Props = React.ComponentPropsWithRef<'canvas'> & {
  options?: ConfettiOptions
  globalOptions?: ConfettiGlobalOptions
  manualstart?: boolean
  children?: ReactNode
}

const ConfettiContext = React.createContext<ConfettiRef | null>(null)

export function useConfetti(): ConfettiRef | null {
  return React.useContext(ConfettiContext)
}

/**
 * A canvas-backed confetti surface. Mount it once (typically inside a
 * `fixed inset-0 pointer-events-none` wrapper) and fire it on a moment worth
 * celebrating — a download finishing, a Pro activation, a first run complete.
 * Adapted from magicui's Confetti, with the Button dependency removed.
 */
const ConfettiComponent = forwardRef<ConfettiRef, Props>((props, ref) => {
  const {
    options,
    globalOptions = { resize: true, useWorker: true },
    manualstart = false,
    children,
    className,
    ...rest
  } = props

  const canvasNodeRef = useRef<HTMLCanvasElement | null>(null)
  const instanceRef = useRef<ConfettiInstance | null>(null)
  const optionsRef = useRef(options)
  const globalOptionsRef = useRef(globalOptions)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useEffect(() => {
    globalOptionsRef.current = globalOptions
  }, [globalOptions])

  useEffect(() => {
    if (canvasNodeRef.current && !instanceRef.current) {
      instanceRef.current = confetti.create(canvasNodeRef.current, {
        resize: true,
        useWorker: true,
        ...globalOptionsRef.current
      })
    }

    return () => {
      instanceRef.current?.reset()
      instanceRef.current = null
    }
  }, [])

  const fire = useCallback(async (opts: ConfettiOptions = {}) => {
    try {
      await instanceRef.current?.({
        ...optionsRef.current,
        ...opts
      })
    } catch (error) {
      console.error('Confetti error:', error)
    }
  }, [])

  const api = useMemo<ConfettiRef>(() => ({ fire }), [fire])

  useImperativeHandle(ref, () => api, [api])

  useEffect(() => {
    if (!manualstart) {
      void fire()
    }
  }, [manualstart, fire])

  return (
    <ConfettiContext.Provider value={api}>
      <canvas ref={canvasNodeRef} className={className} {...rest} />
      {children}
    </ConfettiContext.Provider>
  )
})

ConfettiComponent.displayName = 'Confetti'

export const Confetti = ConfettiComponent

export interface ConfettiButtonProps
  extends React.ComponentPropsWithoutRef<'button'> {
  options?: ConfettiOptions & ConfettiGlobalOptions
}

/** A plain button that bursts confetti from its own center when clicked. */
export const ConfettiButton = forwardRef<HTMLButtonElement, ConfettiButtonProps>(
  ({ options, children, onClick, ...props }, ref) => {
    const handleClick: ConfettiButtonProps['onClick'] = async (event) => {
      try {
        onClick?.(event)
        if (event?.defaultPrevented) return

        const target = event?.currentTarget
        if (target && 'getBoundingClientRect' in target) {
          const rect = target.getBoundingClientRect()
          const origin = {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight
          }

          await confetti({
            zIndex: 9999,
            ...options,
            origin
          })
        }
      } catch (error) {
        console.error('Confetti button error:', error)
      }
    }

    return (
      <button ref={ref} type="button" onClick={handleClick} {...props}>
        {children}
      </button>
    )
  }
)

ConfettiButton.displayName = 'ConfettiButton'
