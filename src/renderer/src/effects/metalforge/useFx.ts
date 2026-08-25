import { useEffect, useRef, useState } from 'react'
import { createFx, ensureDevice, type FxContext, type FxUniformValue } from './webgpu'

export interface ShaderPreviewsDef {
  /** Display name for the tile. */
  name: string
  /** Raw WGSL source. */
  wgsl: string
  /** Override entry function, if auto-detect fails. */
  entry?: string
  /** Initial uniform values (colors etc.) as flat arrays. */
  uniforms?: FxUniformValue
  /** Which preset label to show under the tile. */
  style?: string
  /** Some effects use a named clock rather than the conventional `time`. */
  clockUniform?: string
  clockScale?: number
  maxPixelRatio?: number
}

export interface UseFxRunnerOptions {
  device: GPUDevice | null
  canvas: HTMLCanvasElement | null
  wgsl: string
  entry?: string
  startUniforms?: FxUniformValue
  label?: string
  clockUniform?: string
  clockScale?: number
  maxPixelRatio?: number
  /** If set, pauses the animation (e.g. when offscreen). */
  paused?: boolean
}

/** Runs a single-pass fx on a canvas and returns a handle to mutate uniforms. */
export function useFxRunner({
  device,
  canvas,
  wgsl,
  entry,
  startUniforms,
  label,
  clockUniform,
  clockScale,
  maxPixelRatio,
  paused,
}: UseFxRunnerOptions): FxContext | null {
  const [ctx, setCtx] = useState<FxContext | null>(null)
  const ctxRef = useRef<FxContext | null>(null)
  const pausedRef = useRef(false)
  pausedRef.current = !!paused

  useEffect(() => {
    if (!device || !canvas || !wgsl) return
    let active = true
    let c: FxContext | null = null
    createFx(device, canvas, wgsl, { entry, startUniforms, label, clockUniform, clockScale, maxPixelRatio })
      .then((x) => {
        if (!active) {
          x.destroy()
          return
        }
        c = x
        x.resize()
        x.render(performance.now())
        ctxRef.current = x
        setCtx(x)
      })
      .catch((e) => {
        console.error('[mf-fx] createFx failed', e)
      })

    return () => {
      active = false
      c?.destroy()
      ctxRef.current = null
      setCtx(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, canvas, wgsl])

  // Animate in a rAF loop.
  useEffect(() => {
    if (!canvas) return
    let raf = 0
    const loop = (now: number) => {
      if (!pausedRef.current) ctxRef.current?.render(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [canvas])

  useEffect(() => {
    if (!canvas || !ctx) return
    const observer = new ResizeObserver(() => ctx.resize())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas, ctx])

  return ctx
}

/** Creates a shared GPU device once. Returns null while loading / if unsupported. */
export function useGpuDevice(): {
  device: GPUDevice | null
  error: string | null
} {
  const [device, setDevice] = useState<GPUDevice | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ensureDevice()
      .then((d) => {
        if (!active) return
        setDevice(d)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      active = false
    }
  }, [])

  return { device, error }
}
