import { useEffect, useMemo, useRef, useState } from 'react'
import { useGpuDevice, useFxRunner, type ShaderPreviewsDef } from './useFx'
import molten from './shaders/effect_16.wgsl?raw'
import smoke from './shaders/effect_17.wgsl?raw'
import nova from './shaders/effect_07.wgsl?raw'
import glass from './shaders/effect_08.wgsl?raw'
import grain from './shaders/effect_11.wgsl?raw'
import plasma from './shaders/effect_03.wgsl?raw'
import dots from './shaders/effect_04.wgsl?raw'
import earth from './shaders/effect_06.wgsl?raw'
import ink from './shaders/effect_21.wgsl?raw'
import chrome from './shaders/effect_22.wgsl?raw'
import wallpaper from './shaders/effect_13.wgsl?raw'
import starfield from './shaders/effect_19.wgsl?raw'
import clouds from './shaders/effect_20.wgsl?raw'
import rings from './shaders/effect_18.wgsl?raw'
import hyperspace from './shaders/effect_12.wgsl?raw'
import progress from './shaders/effect_01.wgsl?raw'

// Each effect's entry fn name (auto-detect uses the first `fn xxx(vec2)->vec4`).
const FX: ShaderPreviewsDef[] = [
  { name: 'Molten', wgsl: molten, entry: 'moltenAnim', style: '熔岩 + 裂缝', uniforms: { speed: 0.5, scale: 2.6, warp: 0.6, crack: 0.7, detail: 0.5, heat: 1.2, grain: 0.2, vignette: 0.4, rockColor: [0.08, 0.07, 0.06, 1], emberColor: [1.0, 0.22, 0.02, 1], midColor: [1.0, 0.45, 0.08, 1], hotColor: [1.0, 0.85, 0.45, 1] } },
  { name: 'Nova', wgsl: nova, entry: 'novaAnim', style: '等离子星球', uniforms: { surfaceColor: [0.3, 0.1, 0.8, 1], coreColor: [1, 0.9, 0.7, 1], haloColor: [0.4, 0.2, 1, 1], tint: [0.6, 0.3, 1, 1], background: [0, 0, 0, 1] } },
  { name: 'Glass Orb', wgsl: glass, entry: 'glassOrbAnim', style: '折射玻璃球', uniforms: { tint: [0.3, 0.7, 1, 1], depth: [0.1, 0.5, 0.9, 1], highlight: [1, 1, 1, 1] } },
  { name: 'Smoke', wgsl: smoke, entry: 'smokeAnim', style: '烟雾升腾', uniforms: { speed: 0.3, scaleX: 2.2, scaleY: 1.6, sharpness: 1.2, fade: 0.9, amount: 1.4, bgColor: [0.02, 0.02, 0.03, 1], smokeColor: [0.55, 0.56, 0.62, 1] } },
  { name: 'Grain', wgsl: grain, entry: 'grainAnim', style: '颗粒色网格', uniforms: { brightness: 1.0, flow: 0.6, color1: [0.9,0.6,0.3,1], color2: [0.4,0.7,0.9,1], color3: [0.9,0.3,0.5,1], color4: [0.3,0.9,0.6,1], color5: [0.9,0.8,0.2,1], color6: [0.6,0.4,0.9,1], color7: [0.2,0.8,0.9,1], color8: [0.9,0.5,0.7,1], color9: [0.5,0.9,0.5,1] } },
  { name: 'Plasma', wgsl: plasma, entry: 'plasmaAnim', style: '等离子', uniforms: { scale: 1.0, intensity: 1.0, distortion: 0.5, c1: [1,0,0.5,1], c2: [0.2,0.5,1,1], c3: [0.6,0.2,1,1], c4: [0,1,0.8,1], c5: [1,0.8,0.2,1] } },
  { name: 'Dots', wgsl: dots, entry: 'dotsField', style: '波点场', uniforms: { speed: 0.5, brightness: 1.0, dotSize: 0.9, gridDensity: 1.6, patternScale: 2.0, horizon: 0.1, amplitude: 0.7, depthFade: 0.6, tint: [0.5, 0.7, 1, 1], background: [0.02, 0.02, 0.06, 1] } },
  { name: 'Spinning Earth', wgsl: earth, entry: 'spinningEarthAnim', style: '旋转地球', uniforms: { speed: 0.08, tilt: 0.35, globeSize: 0.75, detail: 9.0, dotSize: 1.2, offsetY: 0.0, sweepSpeed: 0.15, contourBands: 4, style: 0, landColor: [0.15, 0.6, 0.3, 1], oceanColor: [0.06, 0.25, 0.6, 1], atmosphere: [0.4, 0.6, 1, 1], sweepColor: [0.2, 0.9, 0.7, 1], gridColor: [0.6, 0.8, 1, 1], contourLow: [0, 0.4, 0.3, 1], contourHigh: [0.2, 0.9, 0.5, 1] } },
  { name: 'Ink Smoke', wgsl: ink, entry: 'inkSmoke', style: '水墨', uniforms: { scale: 1.0, warp: 0.8, highlight: 0.6, ink1: [0.2,0.2,0.3,1], ink2: [0.4,0.5,0.6,1], ink3: [0.8,0.5,0.3,1], ink4: [0.1,0.1,0.2,1], glow: [0.9,0.6,0.3,1] } },
  { name: 'Liquid Chrome', wgsl: chrome, entry: 'liquidChromeAnim', style: '液态铬', uniforms: { scale: 1.0, warp: 0.6, contrast: 1.0, specPower: 32, specStrength: 0.8, shadow: [0.05,0.05,0.1,1], silver: [0.7,0.75,0.8,1], highlight: [1,1,1,1], tint: [0.3,0.6,1,1] } },
  { name: 'Wallpaper', wgsl: wallpaper, entry: 'wallpaperMain', style: '网格渐变', uniforms: { mode: 0, scale: 1.2, warp: 0.4, contrast: 1.0, band: 0.5, color1: [0.2,0.4,0.9,1], color2: [0.5,0.2,0.9,1], color3: [0.1,0.9,0.7,1], color4: [0.9,0.4,0.6,1], color5: [0.3,0.8,0.9,1] } },
  { name: 'Starfield', wgsl: starfield, entry: 'starfield', style: '星野', uniforms: { speed: 0.4, layers: 6, baseScale: 1.0, scaleStep: 1.7, density: 0.75, starSize: 1.4, twinkleSpeed: 1.0, twinkleAmount: 0.6, starColor: [1, 0.97, 0.9, 1], background: [0.01, 0.01, 0.03, 1] } },
  { name: 'Fractal Clouds', wgsl: clouds, entry: 'fractalCloudsAnim', style: '分形云', uniforms: { zoom: 1.4, driftX: 0.03, driftY: 0.01, warp: 0.5, coverage: 0.5, skyColor: [0.1,0.3,0.6,1], cloudColor: [0.95,0.95,0.9,1], warmTint: [1,0.8,0.5,1] } },
  { name: 'Concentric Rings', wgsl: rings, entry: 'concentricRingsAnim', style: '同心环', uniforms: { amplitude: 0.5, wavelength: 0.2, speed: 0.2, decay: 0.3, sheenColor: [0.6,0.4,0.9,1] } },
  { name: 'Hyperspace', wgsl: hyperspace, entry: 'hyperspace', style: '超空间', uniforms: { speed: 1.2, cycle: 2.2, tunnelTime: 1.4, pause: 0.2, start: 0.4, repeats: 0, stars: 1, starDensity: 0.8, starSize: 1.0, starLength: 2.5, starSpeed: 1.5, starSpread: 0.5, twinkle: 0.5, warpGlow: 0.6, tunnelBright: 0.9, tunnelGlow: 0.5, exposure: 1.0, vignette: 0.5, tint: [0.5, 0.4, 1, 1], starTint: [0.7, 0.8, 1, 1], core: [1, 0.95, 0.7, 1], flare: [0.4, 0.3, 1, 1] } },
  { name: 'Progress', wgsl: progress, entry: 'progressBar', style: '进度条', uniforms: { style: 0, progress: 62, alive: 1, warp: 1.0, grain: 0.1, background: [0.04, 0.04, 0.07, 1], color1: [0.1, 0.4, 0.9, 1], color2: [0.3, 0.9, 0.6, 1], color3: [1, 0.5, 0.2, 1], color4: [0.6, 0.3, 1, 1], color5: [0.9, 0.2, 0.4, 1], color6: [0.3, 1, 0.9, 1], color7: [1, 0.8, 0.3, 1] } },
]

function FxTile({ fx, device }: { fx: ShaderPreviewsDef; device: GPUDevice | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hovered, setHovered] = useState(false)

  useFxRunner({
    device,
    canvas: canvasRef.current,
    wgsl: fx.wgsl,
    entry: fx.entry,
    startUniforms: fx.uniforms,
    label: `mf-${fx.name}`,
    paused: false,
  })

  return (
    <figure
      className="group relative aspect-square overflow-hidden rounded-xl border border-line bg-ink transition-transform duration-300 hover:z-10 hover:scale-[1.04] hover:shadow-[0_0_30px_-8px_rgba(120,120,255,0.35)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      <figcaption className="pointer-events-none absolute left-2 bottom-2 z-10 translate-y-1 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
        <div className="rounded-md bg-black/55 px-2 py-1 backdrop-blur">
          <div className="text-[12px] font-medium text-paper">{fx.name}</div>
          <div className="text-[10px] text-mist">{fx.style}</div>
        </div>
      </figcaption>
      <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/0 transition-all" />
      {hovered && device && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] text-mist">live</div>
      )}
    </figure>
  )
}

export function MetalForgePreview() {
  const { device, error } = useGpuDevice()
  const [filter, setFilter] = useState('')
  const [running, setRunning] = useState(true)

  // Device may be null briefly; tiles wait for it. Re-render when device arrives.
  const effects = useMemo(() => {
    return filter ? FX.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())) : FX
  }, [filter])

  useEffect(() => {
    if (running) return
    // pause tile rAF via remount key
  }, [running])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink p-8 text-center">
        <div className="text-[15px] font-medium text-paper">WebGPU 不可用</div>
        <div className="max-w-[420px] text-[12px] leading-relaxed text-mist">
          {error}
        </div>
        <div className="max-w-[420px] text-[11px] leading-relaxed text-mist">
          请确认 Electron ≥ 43 且启用了 WebGPU（Chromium 原生支持）。也可在
          <code className="mx-1 rounded bg-raised px-1">main</code> 进程加开关启动：
          <code className="mx-1 rounded bg-raised px-1">app.commandLine.appendSwitch('enable-unsafe-webgpu')</code>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-ink text-paper">
      <header className="app-drag flex h-[64px] shrink-0 items-center justify-between border-b border-line px-6">
        <div>
          <div className="text-[18px] font-semibold leading-none">MetalForge 动效</div>
          <div className="mt-1 text-[11px] text-mist">WebGPU 实时预览 · 已载入 WGSL 源码</div>
        </div>
        <div className="app-no-drag flex items-center gap-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索效果…"
            className="rounded-lg bg-raised px-3 py-1.5 text-[12px] text-paper outline-none placeholder:text-mist"
          />
          <button
            type="button"
            onClick={() => setRunning((r) => !r)}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-paper"
          >
            {running ? '暂停' : '播放'}
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6 scroll-quiet">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {effects.map((fx) =>
            running ? (
              <FxTile key={fx.name} fx={fx} device={device} />
            ) : (
              <div key={fx.name} className="flex aspect-square items-center justify-center rounded-xl border border-line bg-raised text-[12px] text-mist">
                {fx.name} · 暂停
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
