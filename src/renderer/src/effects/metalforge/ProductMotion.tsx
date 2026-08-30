import { useEffect, useRef, useState, type ReactNode } from 'react'
import progress from './shaders/effect_01.wgsl?raw'
import liquidChrome from './shaders/effect_22.wgsl?raw'
import { useFxRunner, useGpuDevice, type ShaderPreviewsDef } from './useFx'
import { advanceProgressMotion, createProgressMotion } from './progressMotion'
import type { FxContext } from './webgpu'

// Slosh was authored as an opaque preview tile. Product UI needs the liquid,
// not the tile: derive alpha from the distance to the preset background and
// emit premultiplied color so the WebGPU canvas composes like a native material.
const transparentSlosh = `${progress}

fn ndmSlosh(uv01: vec2<f32>) -> vec4<f32> {
  let raw = progressBar(uv01);
  let delta = abs(raw.rgb - u.background.rgb);
  let energy = max(delta.r, max(delta.g, delta.b));
  let alpha = smoothstep(0.018, 0.42, energy);
  return vec4<f32>(raw.rgb * alpha, alpha);
}`

const TRANSFER: ShaderPreviewsDef = {
  name: 'Slosh',
  wgsl: transparentSlosh,
  entry: 'ndmSlosh',
  maxPixelRatio: 2,
  uniforms: {
    // Preserve Slosh's motion preset; color is supplied by the active NDM theme.
    style: 1, progress: 0, alive: 1, warp: 0, scale: 9.5, amount: 0.135,
    lag: 1.4, echo: 0.082, bloom: 0.95, jitter: 0.3, grain: 0.003,
    frontIn: -0.12, frontOut: 0.12, feather: 1, churn: 1, ripple: 1,
    falloff: 1, trails: 3, trailGlow: 1, haze: 1, vignette: 1,
    pulse: 0.28, pulseRate: 3, stagger: 0.18, cellSize: 1, fill: 1,
    density: 1, turbulence: 1, sparkle: 1,
    background: [0.0627, 0.0667, 0.0784, 1],
    color1: [0.0627, 0.0667, 0.0784, 1],
    color2: [0.0941, 0.1294, 0.2275, 1],
    color3: [0.1608, 0.3098, 0.5333, 1],
    color4: [0.3569, 0.5451, 0.7686, 1],
    color5: [0.7843, 0.8471, 0.9176, 1],
    color6: [0.1608, 0.3098, 0.5333, 1],
    color7: [0.3569, 0.5451, 0.7686, 1]
  }
}

type ProductTheme = 'walnut' | 'dawn' | 'noon'

const TRANSFER_PALETTES: Record<ProductTheme, Record<string, number[]>> = {
  walnut: {
    background: [0.0627, 0.0667, 0.0784, 1], color1: [0.0627, 0.0667, 0.0784, 1],
    color2: [0.0941, 0.1294, 0.2275, 1], color3: [0.1608, 0.3098, 0.5333, 1],
    color4: [0.3569, 0.5451, 0.7686, 1], color5: [0.7843, 0.8471, 0.9176, 1],
    color6: [0.1608, 0.3098, 0.5333, 1], color7: [0.3569, 0.5451, 0.7686, 1]
  },
  dawn: {
    background: [0.9451, 0.9451, 0.9373, 1], color1: [0.9451, 0.9451, 0.9373, 1],
    color2: [0.8784, 0.9059, 0.9373, 1], color3: [0.6784, 0.7451, 0.8275, 1],
    color4: [0.4392, 0.5451, 0.6627, 1], color5: [0.1961, 0.302, 0.4235, 1],
    color6: [0.7176, 0.7922, 0.8627, 1], color7: [0.4745, 0.6, 0.7255, 1]
  },
  noon: {
    background: [0.9608, 0.9647, 0.9686, 1], color1: [0.9608, 0.9647, 0.9686, 1],
    color2: [0.898, 0.9294, 0.9647, 1], color3: [0.7412, 0.8196, 0.898, 1],
    color4: [0.498, 0.651, 0.7765, 1], color5: [0.1922, 0.3647, 0.502, 1],
    color6: [0.7686, 0.851, 0.9176, 1], color7: [0.5255, 0.6941, 0.8235, 1]
  }
}

const TRANSFER_TUNING: Record<ProductTheme, Record<string, number>> = {
  walnut: { bloom: 0.95, haze: 1, trailGlow: 1, grain: 0.003 },
  dawn: { bloom: 0.52, haze: 0.62, trailGlow: 0.74, grain: 0.0012 },
  noon: { bloom: 0.48, haze: 0.58, trailGlow: 0.68, grain: 0.001 }
}

function currentProductTheme(): ProductTheme {
  const theme = document.documentElement.dataset.theme
  return theme === 'dawn' || theme === 'noon' ? theme : 'walnut'
}

function useProductTheme(): ProductTheme {
  const [theme, setTheme] = useState<ProductTheme>(currentProductTheme)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(currentProductTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
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
  beforeRender,
  className
}: {
  effect: ShaderPreviewsDef
  uniforms?: Record<string, number | number[]>
  beforeRender?: (runner: FxContext, nowMs: number) => void
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
    paused: reducedMotion,
    beforeRender
  })

  useEffect(() => {
    if (!runner || !uniforms) return
    for (const [name, value] of Object.entries(uniforms)) runner.setUniform(name, value)
  }, [runner, uniforms])

  return <canvas ref={canvasRef} aria-hidden className={className} />
}

export function TransferField({
  progressFraction,
  identity = 'preview'
}: {
  progressFraction: number
  identity?: number | string
}) {
  const theme = useProductTheme()
  const targetRef = useRef(progressFraction)
  const identityRef = useRef(identity)
  const motionRef = useRef(createProgressMotion(progressFraction))
  targetRef.current = progressFraction
  if (identityRef.current !== identity) {
    identityRef.current = identity
    motionRef.current = createProgressMotion(progressFraction)
  }

  return (
    <ShaderCanvas
      effect={TRANSFER}
      uniforms={{ ...TRANSFER_PALETTES[theme], ...TRANSFER_TUNING[theme] }}
      beforeRender={(runner, nowMs) => {
        const motion = advanceProgressMotion(motionRef.current, nowMs, targetRef.current)
        runner.setUniform('progress', motion.progress * 100)
        // Keep the liquid front subtly alive between engine progress snapshots.
        // The extracted effect expects a small idle pulse; feeding zero makes the
        // surface look like a static rectangular fill whenever the target stalls.
        runner.setUniform('alive', Math.max(0.2, motion.activity))
        runner.setUniform('warp', motion.warp)
      }}
      className={`pointer-events-none absolute inset-0 h-full w-full [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)] ${
        theme === 'walnut' ? 'opacity-[0.64]' : theme === 'dawn' ? 'opacity-[0.46]' : 'opacity-[0.42]'
      }`}
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
      <MotionCard title="正在下载 · Slosh" note="透明材质层；跟随主题与实际进度流动">
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
