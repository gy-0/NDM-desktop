import { useEffect, useRef, type ReactNode } from 'react'
import progress from './shaders/effect_01.wgsl?raw'
import liquidChrome from './shaders/effect_22.wgsl?raw'
import { useFxRunner, useGpuDevice, type ShaderPreviewsDef } from './useFx'

const TRANSFER: ShaderPreviewsDef = {
  name: 'Slosh',
  wgsl: progress,
  entry: 'progressBar',
  clockUniform: 'warp',
  clockScale: 1.3,
  maxPixelRatio: 1.25,
  uniforms: {
    // MetalForge's exact Slosh preset. Style 1 is Slosh; style 3 is Spring.
    style: 1, progress: 0, alive: 1, warp: 0, scale: 9.5, amount: 0.135,
    lag: 1.4, echo: 0.082, bloom: 0.95, jitter: 0.3, grain: 0.01,
    frontIn: -0.12, frontOut: 0.12, feather: 1, churn: 1, ripple: 1,
    falloff: 1, trails: 3, trailGlow: 1, haze: 1, vignette: 1,
    pulse: 0.28, pulseRate: 3, stagger: 0.18, cellSize: 1, fill: 1,
    density: 1, turbulence: 1, sparkle: 1,
    background: [0.062745, 0.07451, 0.105882, 1],
    color1: [0.015686, 0.031373, 0.098039, 1],
    color2: [0.023529, 0.086275, 0.270588, 1],
    color3: [0.058824, 0.239216, 0.698039, 1],
    color4: [0.278431, 0.580392, 1, 1],
    color5: [0.780392, 0.901961, 1, 1],
    color6: [0.058824, 0.239216, 0.698039, 1],
    color7: [0.278431, 0.580392, 1, 1]
  }
}

const DROP: ShaderPreviewsDef = {
  name: 'Liquid Chrome',
  wgsl: liquidChrome,
  entry: 'liquidChromeAnim',
  maxPixelRatio: 1.25,
  uniforms: {
    speed: 0.09, scale: 1.35, warp: 0.7, contrast: 1.45,
    specPower: 28, specStrength: 0.62, tintStrength: 0.26,
    shadow: [0.025, 0.028, 0.034, 1], silver: [0.38, 0.41, 0.44, 1],
    highlight: [0.86, 0.85, 0.81, 1], tint: [0.34, 0.45, 0.4, 1]
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
    clockUniform: effect.clockUniform,
    clockScale: effect.clockScale,
    maxPixelRatio: effect.maxPixelRatio,
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
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.78] [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
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

export function ProductMotionLab() {
  return (
    <main className="grid h-full grid-cols-2 gap-4 bg-ink p-6 pt-16 text-paper">
      <MotionCard title="正在下载 · Slosh" note="原始蓝色预设；实际进度驱动流动边界">
        <TransferField progressFraction={0.63} />
      </MotionCard>
      <MotionCard title="拖入链接" note="只有有效链接进入窗口时出现">
        <DropField />
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
