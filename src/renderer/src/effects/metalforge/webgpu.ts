// ─────────────────────────────────────────────────────────────────────────────
// MetalForge WebGPU live-preview engine.
//
// Runs a single-pass fragment shader: a `fn xxxAnim(uv01: vec2<f32>) -> vec4<f32>`
// plus its `struct Uniforms` block, on a full-screen quad, driven by time + size
// (synthesized) and user/pointer uniforms.
//
// Notes on the WGSL math the effects use:
//   - Effects are written as `uniform variable u` referencing `u.size`, `u.time`.
//   - We let the effect's own `@group(0) @binding(0) var<uniform> u: Uniforms;`
//     line survive (it references the struct the functions use), and add only a
//     vertex + fragment entry point that calls the effect's `xxxAnim(uv)`.
//   - `layout:'auto'`: get the bind group layout from the *pipeline*, not module.
// ─────────────────────────────────────────────────────────────────────────────

export interface FxUniformValue {
  [key: string]: number | number[]
}

export interface FxOptions {
  label?: string
  /** Override fragment entry fn. Default: first `fn xxx(vec2<f32>) -> vec4<f32>`. */
  entry?: string
  startUniforms?: FxUniformValue
  /** Drive a non-standard clock uniform such as Progress's `warp`. */
  clockUniform?: string
  clockScale?: number
  /** Background effects do not need full Retina resolution. */
  maxPixelRatio?: number
}

interface UniformFieldDecl {
  name: string
  baseType: 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f'
  offset: number
  size: number
  align: number
}

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a
}

// Parse `struct Uniforms { ... }` with WGSL member alignment.
// (vec4 -> 16, vec3 -> 16, vec2 -> 8, f32/i32/u32 -> 4.)
function parseWgslUniforms(wgsl: string): UniformFieldDecl[] {
  const m = /struct\s+(\w+)\s*\{([\s\S]*?)\}/.exec(wgsl)
  if (!m) return []
  const clean = m[2].replace(/\/\/[^\n]*/g, '')
  const decls: UniformFieldDecl[] = []
  const fieldRe = /([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*(?:\s*<\s*[^>]*\s*>)?)\s*,?/g
  let offset = 0
  let fin: RegExpExecArray | null
  while ((fin = fieldRe.exec(clean))) {
    const name = fin[1]
    const t = fin[2].replace(/\s+/g, '')
    let baseType: UniformFieldDecl['baseType']
    let align = 4
    let size = 4
    if (/^vec4(f|<f32>)/.test(t) || /^vec4<u|vec4<i/.test(t)) {
      baseType = 'vec4f'; align = 16; size = 16
    } else if (/^vec3/.test(t)) {
      baseType = 'vec3f'; align = 16; size = 12
    } else if (/^vec2/.test(t)) {
      baseType = 'vec2f'; align = 8; size = 8
    } else if (/f32/.test(t)) {
      baseType = 'f32'; align = 4; size = 4
    } else if (/^u32|u32$/.test(t)) {
      baseType = 'u32'; align = 4; size = 4
    } else if (/^i32|i32$/.test(t)) {
      baseType = 'i32'; align = 4; size = 4
    } else {
      continue
    }
    offset = alignUp(offset, align)
    decls.push({ name, baseType, offset, size, align })
    offset += size
  }
  return decls
}

function inferEntry(wgsl: string): string {
  const re = /fn\s+([A-Za-z_]\w*)\s*\(\s*\w+\s*:\s*vec2\s*<\s*f32\s*>\s*\)\s*->\s*vec4\s*<\s*f32\s*>/g
  const m = re.exec(wgsl)
  return m ? m[1] : 'main'
}

// The effect functions reference the uniform variable. Detect its name + struct
// name from the source so the binding line that survives matches.
function detectBinding(wgsl: string): { structName: string; varName: string } {
  const m = /@group\(0\)\s*@binding\(0\)\s*var\s*<\s*uniform\s*>\s*(\w+)\s*:\s*(\w+)\s*;/.exec(wgsl)
  if (m) return { varName: m[1], structName: m[2] }
  return { varName: 'u', structName: 'Uniforms' }
}

function fillDefault(decl: UniformFieldDecl): number[] {
  const n = decl.baseType === 'vec4f' ? 4 : decl.baseType === 'vec3f' ? 3 : decl.baseType === 'vec2f' ? 2 : 1
  const arr = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    if (decl.baseType === 'vec4f') arr[i] = i === 3 ? 1 : 0.5
    else if (decl.baseType === 'vec3f') arr[i] = 0.5
    else if (decl.baseType === 'vec2f') arr[i] = 0
    else arr[i] = 0
  }
  return arr
}

export interface FxContext {
  canvas: HTMLCanvasElement
  device: GPUDevice
  resize: () => void
  setPointer: (p: { x: number; y: number; down: boolean }) => void
  setUniform: (name: string, value: number | number[]) => void
  render: (nowMs: number) => void
  destroy: () => void
}

export async function createFx(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  wgslRaw: string,
  opts: FxOptions = {}
): Promise<FxContext> {
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!ctx) throw new Error('webgpu context unavailable')
  const gpu = ctx as GPUCanvasContext
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat()

  const entry = opts.entry ?? inferEntry(wgslRaw)
  const bindMeta = detectBinding(wgslRaw)
  const declarations = parseWgslUniforms(wgslRaw)

  // Strip any pre-existing vertex/fragment entry points that would collide with
  // our `fx_vertex`/`fx_fragment`, and strip statements after the last main body
  // we can't reuse. Safer: keep user functions, strip *entry* functions that use
  // instanced/vertex-buffer stuff (multi-pass) — those fail anyway, so we only
  // rely on single-pass files being passed in.
  const cleaned = wgslRaw
    .replace(/@fragment\s*\n?\s*fn\s+\w+\([^)]*\)\s*->\s*@location\(0\)\s*vec4<f32>\s*\{[\s\S]*?\n\}/g, '')
    .replace(/@vertex\s*\n?\s*fn\s+\w+\([^)]*\)\s*->\s*\w+\s*\{[\s\S]*?\n\}/g, '')

  // Preserve the effect's uniform binding. If it used a different struct/var
  // name than the one we assume, reuse its own names.
  const vert = `
struct FxVSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn fx_vertex(@builtin(vertex_index) vid: u32) -> FxVSOut {
  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var out: FxVSOut;
  let p = pos[vid];
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}
`

  const frag = `
@fragment
fn fx_fragment(in: FxVSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  return ${entry}(uv);
}
`

  const code = `${vert}\n${cleaned}\n\n${frag}`
  const module = device.createShaderModule({ code, label: opts.label ?? 'mf-fx' })

  const pipeline = device.createRenderPipeline({
    label: 'mf-fx-pipeline',
    layout: 'auto',
    vertex: { module, entryPoint: 'fx_vertex' },
    fragment: { module, entryPoint: 'fx_fragment', targets: [{ format: canvasFormat }] },
    primitive: { topology: 'triangle-list' },
  })

  const bgl = pipeline.getBindGroupLayout(0)
  const uniformSize = Math.max(alignUp(declarations.reduce((s, d) => Math.max(s, d.offset + d.size), 0), 16), 16)
  const ubuf = device.createBuffer({
    label: 'mf-fx-uniforms',
    size: uniformSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  })
  void bindMeta

  gpu.configure({ device, format: canvasFormat, alphaMode: 'premultiplied' })

  const declMap: Record<string, UniformFieldDecl> = {}
  for (const d of declarations) declMap[d.name] = d
  const uniforms: Record<string, number[]> = {}
  for (const d of declarations) {
    uniforms[d.name] = fillDefault(d)
  }
  // A frame hook may intentionally drive the clock (the product progress
  // effect does this with its activity-warped `warp` uniform). Keep that
  // override for the current render, while the normal clock remains automatic
  // for effects that do not touch it.
  const manualUniforms = new Set<string>()
  for (const [k, v] of Object.entries(opts.startUniforms ?? {})) {
    uniforms[k] = Array.isArray(v) ? v.slice() : [v]
  }

  const pointer = { x: 0.5, y: 0.5, down: false }
  const uniformData = new ArrayBuffer(uniformSize)
  const uniformView = new DataView(uniformData)
  const clockStartedAt = performance.now()
  const metricsCanvas = canvas as HTMLCanvasElement & { __ndmFxFrames?: number }
  metricsCanvas.__ndmFxFrames = 0
  let cssWidth = 1
  let cssHeight = 1

  function writeUniforms() {
    // Most MetalForge effects expect `size` to be real CSS pixels (they use it
    // for aspect correction / projection / uv*size). ResizeObserver refreshes
    // these cached CSS metrics; the 60 fps render path never forces layout.
    if (uniforms.size) {
      uniforms.size[0] = cssWidth
      uniforms.size[1] = cssHeight
    }
    if (uniforms.aspect) {
      uniforms.aspect[0] = cssWidth / cssHeight
      uniforms.aspect[1] = 1
    }
    for (const d of declarations) {
      const val = uniforms[d.name]
      if (!val) continue
      for (let i = 0; i < d.size / 4; i++) {
        const v = val[Math.min(i, val.length - 1)] ?? 0
        if (d.baseType === 'i32') uniformView.setInt32(d.offset + i * 4, v, true)
        else if (d.baseType === 'u32') uniformView.setUint32(d.offset + i * 4, v, true)
        else uniformView.setFloat32(d.offset + i * 4, v, true)
      }
    }
    device.queue.writeBuffer(ubuf, 0, uniformData)
  }

  function submit(nowMs: number) {
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    metricsCanvas.__ndmFxFrames = (metricsCanvas.__ndmFxFrames ?? 0) + 1
    void nowMs
  }

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? Number.POSITIVE_INFINITY)
    cssWidth = Math.max(1, Math.floor(canvas.clientWidth))
    cssHeight = Math.max(1, Math.floor(canvas.clientHeight))
    const w = Math.max(1, Math.floor(cssWidth * dpr))
    const h = Math.max(1, Math.floor(cssHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
  }

  return {
    canvas,
    device,
    resize,
    setPointer: (p) => {
      pointer.x = p.x
      pointer.y = p.y
      pointer.down = p.down
      if (declMap.pointer) uniforms.pointer = [p.x, p.y]
      if (declMap.mouse) uniforms.mouse = [p.x, p.y, p.down ? 1 : 0]
    },
    setUniform: (name, value) => {
      manualUniforms.add(name)
      const incoming = Array.isArray(value) ? value : [value]
      const target = uniforms[name]
      if (target && target.length === incoming.length) {
        for (let index = 0; index < incoming.length; index += 1) target[index] = incoming[index]
      } else {
        uniforms[name] = incoming.slice()
      }
    },
    render: (nowMs) => {
      if (uniforms.time && !manualUniforms.has('time')) uniforms.time[0] = nowMs / 1000
      if (opts.clockUniform && uniforms[opts.clockUniform] && !manualUniforms.has(opts.clockUniform)) {
        uniforms[opts.clockUniform][0] = ((nowMs - clockStartedAt) / 1000) * (opts.clockScale ?? 1)
      }
      writeUniforms()
      manualUniforms.clear()
      submit(nowMs)
    },
    destroy: () => {
      ubuf.destroy()
    },
  }
}

// Detect if WebGPU is available and return a device.
let sharedDevice: Promise<GPUDevice> | null = null

export async function ensureDevice(): Promise<GPUDevice> {
  if (!sharedDevice) {
    sharedDevice = (async () => {
      if (!navigator.gpu) throw new Error('WebGPU not available')
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) throw new Error('No WebGPU adapter')
      const device = await adapter.requestDevice()
      device.lost.then(() => { sharedDevice = null })
      return device
    })().catch((error) => {
      sharedDevice = null
      throw error
    })
  }
  return sharedDevice
}
