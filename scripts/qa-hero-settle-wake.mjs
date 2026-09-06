/**
 * Pure logic simulation of the Hero host rAF loop's settle-stop / wake behavior
 * (no UI). It mirrors Hero.tsx's tick, requestHeroFrame and the render-phase
 * wake checks against a fake rAF, then drives two scenarios:
 *
 *   1. continuous 4 Hz snapshots pushing the target forward — the loop must
 *      stop between snapshots (settle stop) yet still advance to each new
 *      target after being woken by the snapshot.
 *   2. pause (live=false), task switch, visibility restore — each must repaint
 *      once and then stop again when nothing moves.
 *
 * Run: node scripts/qa-hero-settle-wake.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

// Bundle the real progressMotion.ts so the simulation exercises the exact
// interpolation the app runs (including the settled re-origin rule).
const bundle = await build({
  entryPoints: ['src/renderer/src/effects/metalforge/progressMotion.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  loader: { '.ts': 'ts' }
})
const motionModule = bundle.outputFiles[0].text

const motionUrl = `data:text/javascript;base64,${Buffer.from(motionModule).toString('base64')}`
const { advanceProgressMotion, createProgressMotion } = await import(motionUrl)

const heroSource = readFileSync('src/renderer/src/components/Hero.tsx', 'utf8')

// --- fake browser environment ---------------------------------------------

class FakeRAF {
  constructor() {
    this.now = 0
    this.pending = new Map()
    this.nextHandle = 1
    this.frameCount = 0
  }
  requestAnimationFrame(callback) {
    const handle = this.nextHandle++
    this.pending.set(handle, callback)
    return handle
  }
  cancelAnimationFrame(handle) {
    this.pending.delete(handle)
  }
  advance(ms, step = 16.6) {
    const end = this.now + ms
    while (this.now < end) {
      this.now = Math.min(end, this.now + step)
      this.frameCount += 1
      const callbacks = [...this.pending.values()]
      this.pending.clear()
      for (const callback of callbacks) callback(this.now)
    }
  }
}

function createHarness({ reduceMotion = false } = {}) {
  const raf = new FakeRAF()
  const state = {
    reduceMotion,
    live: true,
    heroVisible: true,
    documentVisible: true,
    fraction: 0,
    paints: []
  }

  // Mirror of the Hero loop: tick + requestHeroFrame + wake paths.
  let frame = 0
  const requestHeroFrame = () => {
    if (state.reduceMotion || frame !== 0) return
    frame = raf.requestAnimationFrame(tick)
  }
  const tick = (nowMs) => {
    frame = 0
    const motion = state.motion
    const painting = state.heroVisible && state.documentVisible
    if (!painting) return
    if (state.live) advanceProgressMotion(motion, nowMs, state.fraction)
    state.paints.push({ at: nowMs, progress: motion.progress, target: motion.targetProgress })
    if (Math.abs(motion.progress - motion.targetProgress) > 0.0005) requestHeroFrame()
  }

  state.motion = createProgressMotion(0)
  state.requestHeroFrame = requestHeroFrame
  state.tick = tick
  state.frameRef = () => frame
  // Render-phase wake: call whenever fraction/live/task/visibility changed.
  state.wakeOnChange = () => requestHeroFrame()
  return { raf, state }
}

// --- scenario 1: 4 Hz snapshots, settle stop, wake, advance -----------------

{
  const { raf, state } = createHarness()
  // First frame runs like the Hero's mount effect.
  state.tick(raf.now)
  raf.advance(1000) // target 0, settled -> loop must be stopped
  assert.equal(state.frameRef(), 0, 'settled loop must not hold a pending frame')
  const paintsAfterIdle = state.paints.length

  // Engine snapshot: 4% -> the render-phase fraction change wakes the loop.
  state.fraction = 0.04
  state.wakeOnChange()
  raf.advance(600) // ~150ms tau settle plus margin for the eased tail
  const samples = state.paints.slice(paintsAfterIdle)
  assert.ok(samples.length >= 8, `must repaint across several frames after wake (got ${samples.length})`)
  const finalProgress = samples[samples.length - 1].progress
  assert.ok(
    Math.abs(finalProgress - 0.04) <= 0.0005,
    `must settle onto the new target after wake (got ${finalProgress})`
  )
  assert.equal(state.frameRef(), 0, 'loop must stop again after settling')

  // No-paint window while settled: another full second of idle frames.
  const paintsBeforeIdle = state.paints.length
  raf.advance(1000)
  assert.equal(state.paints.length, paintsBeforeIdle, 'idle frames must not paint while settled')

  // Three more 4 Hz snapshots in a row, each must wake + advance. With a real
  // 250 ms snapshot cadence the exponential tail does not fully settle between
  // snapshots (0.04 * exp(-250/150) ≈ 0.008 remains), so the loop legitimately
  // keeps running while the download is actively progressing; it must settle
  // once the last snapshot's target is reached and no new one arrives.
  let previous = finalProgress
  for (const fraction of [0.08, 0.12, 0.16]) {
    state.fraction = fraction
    state.wakeOnChange()
    raf.advance(250)
    const last = state.paints[state.paints.length - 1]
    assert.ok(last.progress > previous, `snapshot ${fraction} must move the front forward`)
    assert.ok(Math.abs(last.progress - fraction) <= 0.02, `front must approach ${fraction}`)
    previous = last.progress
  }
  raf.advance(600)
  const settledTail = state.paints[state.paints.length - 1]
  assert.ok(
    Math.abs(settledTail.progress - 0.16) <= 0.0005,
    `front must fully settle after the last snapshot (got ${settledTail.progress})`
  )
  assert.equal(state.frameRef(), 0, 'loop must stop once the tail settles')
  console.log('scenario 1 (snapshot wake + settle stop) OK')
}

// --- scenario 2: pause, task switch, visibility gates -----------------------

{
  const { raf, state } = createHarness()
  state.tick(raf.now)
  state.fraction = 0.3
  state.wakeOnChange()
  raf.advance(1000)
  assert.equal(state.frameRef(), 0, 'must settle before pause scenario')

  // live -> paused: wake fires, one repaint syncs the DOM, then it stops.
  const paintsBeforePause = state.paints.length
  state.live = false
  state.wakeOnChange()
  raf.advance(500)
  const pausePaints = state.paints.slice(paintsBeforePause)
  assert.equal(pausePaints.length, 1, 'pause must paint exactly once (wake + settle stop)')
  assert.equal(state.frameRef(), 0, 'paused loop must be stopped')

  // paused -> downloading resumes easing from the frozen front (no jump).
  state.live = true
  state.fraction = 0.36
  state.wakeOnChange()
  raf.advance(1000)
  const resumePaints = state.paints.slice(-60)
  assert.ok(
    resumePaints[0].progress <= resumePaints[resumePaints.length - 1].progress,
    'resume must never rewind the front'
  )
  assert.ok(
    Math.abs(state.paints[state.paints.length - 1].progress - 0.36) <= 0.001,
    'resume must settle onto the new target'
  )
  assert.equal(state.frameRef(), 0, 'resumed loop must settle and stop')

  // Task switch: fraction becomes authoritative from the new task.
  state.fraction = 0.75
  state.wakeOnChange()
  raf.advance(1000)
  const switched = state.paints[state.paints.length - 1]
  assert.ok(Math.abs(switched.progress - 0.75) <= 0.001, 'task switch must wake and advance')
  assert.equal(state.frameRef(), 0, 'switched loop must settle and stop')

  // Offscreen: wake fires (IO event), tick must not paint while hidden.
  const paintsBeforeHide = state.paints.length
  state.heroVisible = false
  state.wakeOnChange()
  raf.advance(250)
  assert.equal(state.paints.length, paintsBeforeHide, 'offscreen wake must not paint')

  // Back on screen: wake repaints and the live front continues from where the
  // visible frames left it.
  state.heroVisible = true
  state.wakeOnChange()
  raf.advance(250)
  assert.ok(state.paints.length > paintsBeforeHide, 'restore must wake and paint again')

  // Hidden document behaves like offscreen.
  const paintsBeforeDocHide = state.paints.length
  state.documentVisible = false
  state.wakeOnChange()
  raf.advance(250)
  assert.equal(state.paints.length, paintsBeforeDocHide, 'hidden document wake must not paint')

  console.log('scenario 2 (pause/switch/visibility gates) OK')
}

// --- reduced motion stays out of the loop -----------------------------------

{
  const { raf, state } = createHarness({ reduceMotion: true })
  // The mount effect returns early under reduce (no tick, no paints), and the
  // render-phase wake routes through the reduce gate.
  state.fraction = 0.5
  state.wakeOnChange()
  raf.advance(500)
  assert.equal(state.frameRef(), 0, 'reduced motion must never hold a pending frame')
  assert.equal(state.paints.length, 0, 'reduced motion must never enter the host loop')
  console.log('reduced-motion path OK')
}

// --- static guards on the real component ------------------------------------

// The component must keep the three wake sources wired to requestHeroFrame.
assert.ok(
  /requestHeroFrame\(\)\n  \}\n\n  useEffect/.test(heroSource),
  'render-phase wake must request a frame'
)
assert.match(heroSource, /wakeRef\.current\(\)/, 'observer + visibilitychange must route through the wake ref')
assert.match(heroSource, /MOTION_SETTLE_EPSILON/, 'settle check must use the shared epsilon')
// The tick must repaint both consumers before it may stop.
assert.match(heroSource, /connectionsRef\.current\?\.paint\(motion, nowMs\)/)
assert.match(heroSource, /transferRef\.current\?\.render\(nowMs\)/)

console.log('\nAll settle/wake simulations passed.')
