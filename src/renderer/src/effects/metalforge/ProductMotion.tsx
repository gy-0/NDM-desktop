import { useEffect, useRef, useState, type ReactNode } from 'react'
import progress from './shaders/effect_01.wgsl?raw'
import liquidChrome from './shaders/effect_22.wgsl?raw'
import { useFxRunner, useGpuDevice, type ShaderPreviewsDef } from './useFx'

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
  clockUniform: 'warp',
  clockScale: 1.3,
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
    color2: [0.8745, 0.8941, 0.9137, 1], color3: [0.6588, 0.7176, 0.7843, 1],
    color4: [0.4353, 0.5412, 0.651, 1], color5: [0.2, 0.2824, 0.3725, 1],
    color6: [0.6588, 0.7176, 0.7843, 1], color7: [0.4353, 0.5412, 0.651, 1]
  },
  noon: {
    background: [0.9608, 0.9647, 0.9686, 1], color1: [0.9608, 0.9647, 0.9686, 1],
    color2: [0.8824, 0.902, 0.9255, 1], color3: [0.6824, 0.7294, 0.7843, 1],
    color4: [0.4431, 0.5255, 0.6196, 1], color5: [0.2, 0.2745, 0.3569, 1],
    color6: [0.6824, 0.7294, 0.7843, 1], color7: [0.4431, 0.5255, 0.6196, 1]
  }
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
  const theme = useProductTheme()
  return (
    <ShaderCanvas
      effect={TRANSFER}
      uniforms={{ ...TRANSFER_PALETTES[theme], progress: Math.max(0, Math.min(100, progressFraction * 100)) }}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.58] [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]"
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
