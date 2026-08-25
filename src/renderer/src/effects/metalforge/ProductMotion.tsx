import { useEffect, useRef, type ReactNode } from 'react'
import progress from './shaders/effect_01.wgsl?raw'
import glassOrb from './shaders/effect_08.wgsl?raw'
import liquidChrome from './shaders/effect_22.wgsl?raw'
import { useFxRunner, useGpuDevice, type ShaderPreviewsDef } from './useFx'

const TRANSFER: ShaderPreviewsDef = {
  name: 'Transfer',
  wgsl: progress,
  entry: 'progressBar',
  uniforms: {
    style: 3, progress: 0, alive: 1, warp: 1, scale: 12, amount: 0.16,
    lag: 0.12, echo: 2, bloom: 0.75, jitter: 0.03, grain: 0.05,
    frontIn: -0.08, frontOut: 0.08, feather: 1.1, churn: 0.7, ripple: 0.8,
    falloff: 1.1, trails: 2, trailGlow: 0.2, haze: 0.08, vignette: 0.4,
    pulse: 0.12, pulseRate: 0.7, stagger: 0.12, cellSize: 14, fill: 0.72,
    density: 0.55, turbulence: 0.4, sparkle: 0.12,
    background: [0.035, 0.038, 0.045, 1],
    color1: [0.22, 0.24, 0.28, 1], color2: [0.42, 0.46, 0.48, 1],
    color3: [0.56, 0.62, 0.58, 1], color4: [0.76, 0.74, 0.69, 1],
    color5: [0.47, 0.52, 0.55, 1], color6: [0.62, 0.67, 0.63, 1],
    color7: [0.82, 0.8, 0.76, 1]
  }
}

const DROP: ShaderPreviewsDef = {
  name: 'Liquid Chrome',
  wgsl: liquidChrome,
  entry: 'liquidChromeAnim',
  uniforms: {
    speed: 0.09, scale: 1.35, warp: 0.7, contrast: 1.45,
    specPower: 28, specStrength: 0.62, tintStrength: 0.26,
    shadow: [0.025, 0.028, 0.034, 1], silver: [0.38, 0.41, 0.44, 1],
    highlight: [0.86, 0.85, 0.81, 1], tint: [0.34, 0.45, 0.4, 1]
  }
}

const COMPLETE: ShaderPreviewsDef = {
  name: 'Glass Orb',
  wgsl: glassOrb,
  entry: 'glassOrbAnim',
  uniforms: {
    style: 2, speed: 0.24, waveFreq: 0.82, amplitude: 0.64,
    tint: [0.42, 0.56, 0.49, 1], depth: [0.14, 0.2, 0.17, 1],
    highlight: [0.96, 0.94, 0.88, 1]
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function ShaderCanvas({
  effect,
  uniforms,
  className
}: {
  effect: ShaderPreviewsDef
  uniforms?: Record<string, number | number[]>
  className: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { device } = useGpuDevice()
  const reducedMotion = prefersReducedMotion()
  const runner = useFxRunner({
    device,
    canvas: canvasRef.current,
    wgsl: effect.wgsl,
    entry: effect.entry,
    startUniforms: { ...effect.uniforms, ...uniforms },
    label: `ndm-${effect.name}`,
    paused: reducedMotion
  })

  useEffect(() => {
    if (!runner || !uniforms) return
    for (const [name, value] of Object.entries(uniforms)) runner.setUniform(name, value)
  }, [runner, uniforms])

  return <canvas ref={canvasRef} aria-hidden className={className} />
}

export function TransferField({ progressFraction }: { progressFraction: number }) {
  return (
    <ShaderCanvas
      effect={TRANSFER}
      uniforms={{ progress: Math.max(0, Math.min(100, progressFraction * 100)) }}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.16] [mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]"
    />
  )
}

export function DropField() {
  return (
    <ShaderCanvas
      effect={DROP}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]"
    />
  )
}

export function CompletionField({ contained = false }: { contained?: boolean }) {
  return (
    <div className={`pointer-events-none inset-0 grid place-items-center overflow-hidden ${contained ? 'absolute' : 'fixed z-[49]'}`} aria-hidden>
      <ShaderCanvas
        effect={COMPLETE}
        className={`h-[min(58vw,520px)] w-[min(58vw,520px)] opacity-50 mix-blend-screen ${contained ? '' : 'animate-[complete-halo_1.2s_ease-out_both]'}`}
      />
    </div>
  )
}

export function ProductMotionLab() {
  return (
    <main className="grid h-full grid-cols-3 gap-4 bg-ink p-6 pt-16 text-paper">
      <MotionCard title="正在下载" note="进度直接驱动流动边界">
        <TransferField progressFraction={0.63} />
      </MotionCard>
      <MotionCard title="拖入链接" note="只有有效链接进入窗口时出现">
        <DropField />
      </MotionCard>
      <MotionCard title="任务完成" note="短暂收束，然后自动消失">
        <CompletionField contained />
      </MotionCard>
    </main>
  )
}

function MotionCard({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="relative min-h-0 overflow-hidden rounded-2xl border border-line bg-panel">
      {children}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-ink via-ink/88 to-transparent px-5 pb-5 pt-16">
        <h1 className="text-[16px] font-medium">{title}</h1>
        <p className="mt-1 text-[11.5px] text-mist">{note}</p>
      </div>
    </section>
  )
}
