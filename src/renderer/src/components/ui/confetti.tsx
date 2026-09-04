import type { ReactNode } from 'react'
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react'
import { createPortal } from 'react-dom'
import type {
  GlobalOptions as ConfettiGlobalOptions,
  CreateTypes as ConfettiInstance,
  Options as ConfettiOptions
} from 'canvas-confetti'
import confetti from 'canvas-confetti'

export type ConfettiRef = {
  fire: (options?: ConfettiOptions) => Promise<void> | void
  clear: () => void
}

type Props = React.ComponentPropsWithRef<'canvas'> & {
  options?: ConfettiOptions
  globalOptions?: ConfettiGlobalOptions
  manualstart?: boolean
  fullscreen?: boolean
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
    globalOptions = { resize: true, useWorker: false },
    manualstart = false,
    fullscreen = false,
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
        useWorker: false,
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
      if (canvasNodeRef.current) {
        const current = Number(canvasNodeRef.current.dataset.confettiFires ?? 0)
        canvasNodeRef.current.dataset.confettiFires = String(current + 1)
        canvasNodeRef.current.dataset.confettiActive = 'true'
      }
      await instanceRef.current?.({
        ...optionsRef.current,
        ...opts
      })
    } catch (error) {
      console.error('Confetti error:', error)
    } finally {
      if (canvasNodeRef.current) canvasNodeRef.current.dataset.confettiActive = 'false'
    }
  }, [])

  const clear = useCallback(() => {
    if (canvasNodeRef.current?.dataset.confettiActive !== 'true') return
    instanceRef.current?.reset()
    canvasNodeRef.current.dataset.confettiActive = 'false'
    const current = Number(canvasNodeRef.current.dataset.confettiClears ?? 0)
    canvasNodeRef.current.dataset.confettiClears = String(current + 1)
  }, [])

  const api = useMemo<ConfettiRef>(() => ({ fire, clear }), [clear, fire])

  useImperativeHandle(ref, () => api, [api])

  useEffect(() => {
    if (!manualstart) {
      void fire()
    }
  }, [manualstart, fire])

  const canvas = <canvas ref={canvasNodeRef} className={className} {...rest} />

  return (
    <ConfettiContext.Provider value={api}>
      {fullscreen && typeof document !== 'undefined' ? createPortal(canvas, document.body) : canvas}
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
