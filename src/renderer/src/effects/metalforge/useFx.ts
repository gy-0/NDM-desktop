import { useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from 'react'
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
  /**
   * When set, the effect does NOT start its own rAF loop. The caller owns the
   * single animation loop and drives the shader through the imperative handle:
   * advance the external motion, then call `handle.render(nowMs)` once per
   * frame. Used by the Hero host loop so the liquid layer and the segment bar
   * paint from the exact same phase on the exact same callback.
   */
  manualRender?: boolean
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
  /** Mutate uniforms immediately before each rendered frame. */
  beforeRender?: (runner: FxContext, nowMs: number) => void
}

/**
 * Imperative handle for a manualRender runner. The owner's single rAF loop
 * calls `render(nowMs)` every frame. Visibility and pause gates are enforced
 * inside, mirroring the automatic loop so the two modes behave identically.
 */
export type FxRunnerHandle = {
  /** Paint the shader at `nowMs`, applying `beforeRender` first. */
  render: (nowMs: number) => void
}

/** Runs a single-pass fx on a canvas and returns a handle to mutate uniforms. */
export function useFxRunner(
  {
    manualRender,
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
    beforeRender,
  }: UseFxRunnerOptions,
  forwardedRef?: ForwardedRef<FxRunnerHandle>
): FxContext | null {
  const [ctx, setCtx] = useState<FxContext | null>(null)
  const ctxRef = useRef<FxContext | null>(null)
  const pausedRef = useRef(false)
  const visibleRef = useRef(true)
  const beforeRenderRef = useRef(beforeRender)
  pausedRef.current = !!paused
  beforeRenderRef.current = beforeRender

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

  // Animate in a rAF loop, unless the owner drives the shader itself.
  useEffect(() => {
    if (manualRender || !canvas) return
    let raf = 0
    const loop = (now: number) => {
      if (!pausedRef.current && visibleRef.current && document.visibilityState === 'visible') {
        const current = ctxRef.current
        if (current) {
          beforeRenderRef.current?.(current, now)
          current.render(now)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualRender, canvas])

  useEffect(() => {
    if (!canvas) return
    const observer = new IntersectionObserver(([entry]) => {
      visibleRef.current = entry?.isIntersecting ?? false
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas])

  useImperativeHandle(
    forwardedRef,
    () => ({
      render: (nowMs: number) => {
        if (pausedRef.current || !visibleRef.current || document.visibilityState !== 'visible') return
        const current = ctxRef.current
        if (current) {
          beforeRenderRef.current?.(current, nowMs)
          current.render(nowMs)
        }
      }
    }),
    []
  )

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
