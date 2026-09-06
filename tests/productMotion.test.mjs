import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const productMotion = fs.readFileSync('src/renderer/src/effects/metalforge/ProductMotion.tsx', 'utf8')
const progressMotion = fs.readFileSync('src/renderer/src/effects/metalforge/progressMotion.ts', 'utf8')
const connections = fs.readFileSync('src/renderer/src/components/Connections.tsx', 'utf8')
const hero = fs.readFileSync('src/renderer/src/components/Hero.tsx', 'utf8')
const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const engine = fs.readFileSync('src/renderer/src/effects/metalforge/webgpu.ts', 'utf8')
const uniformWriter = engine.slice(engine.indexOf('function writeUniforms()'), engine.indexOf('function submit('))

test('MetalForge effects are attached to meaningful product moments', () => {
  assert.match(productMotion, /effect_01\.wgsl\?raw/)
  assert.match(productMotion, /effect_22\.wgsl\?raw/)
  assert.match(productMotion, /name: 'Slosh'/)
  assert.match(productMotion, /entry: 'ndmSlosh'/)
  assert.match(productMotion, /raw\.rgb \* alpha, alpha/)
  assert.match(productMotion, /TRANSFER_PALETTES/)
  assert.match(productMotion, /maxPixelRatio: 2/)
  assert.match(productMotion, /style: 1, progress: 0, alive: 1, warp: 0/)
  assert.match(productMotion, /clockUniform: 'warp'/)
  assert.match(hero, /<TransferField progressFraction=\{fraction\}/)
  assert.doesNotMatch(app, /<DropField/)
  assert.match(app, /Deliberately plain veil: the dialog answers the cursor, no frame or wash/)
  assert.doesNotMatch(productMotion, /CompletionField|Glass Orb|effect_08\.wgsl/)
  assert.doesNotMatch(app, /<CompletionField/)
})

test('download progress interpolates one persistent track at frame rate', () => {
  assert.match(progressMotion, /advanceProgressMotion/)
  assert.match(progressMotion, /target < motion\.progress/)
  assert.match(connections, /requestAnimationFrame/)
  assert.match(connections, /targetSignature/)
  assert.doesNotMatch(connections, /transition-\[transform\]/)
})

test('external shared motion is consumed read-only without a second advance', () => {
  // The Hero drives the single rAF and advances the shared ProgressMotion once
  // per frame. TransferField must consume it read-only (via the consumingShared
  // branch) rather than advancing its own track again, or the liquid warp would
  // desync from the segment bar's clock. Standalone previews keep their own
  // advancing track when no external motion is supplied.
  const sharedBranch = productMotion.slice(
    productMotion.indexOf('if (consumingSharedRef'),
    productMotion.indexOf('const motion = advanceProgressMotion')
  )
  assert.match(sharedBranch, /consumingSharedRef\.current && externalMotion/)
  assert.match(sharedBranch, /externalMotion\.warp/)
  // The read-only branch returns before any advance; only the standalone
  // branch (no external motion) calls advanceProgressMotion.
  assert.doesNotMatch(sharedBranch, /advanceProgressMotion/)
})

test('product shader motion respects reduced motion and avoids per-frame allocation', () => {
  assert.match(productMotion, /prefers-reduced-motion: reduce/)
  assert.match(productMotion, /paused: reducedMotion/)
  assert.match(engine, /let sharedDevice: Promise<GPUDevice> \| null = null/)
  assert.match(engine, /const uniformData = new ArrayBuffer\(uniformSize\)/)
  assert.match(engine, /opts\.clockUniform/)
  assert.match(engine, /opts\.maxPixelRatio/)
  assert.match(engine, /let cssWidth = 1/)
  assert.doesNotMatch(uniformWriter, /canvas\.clientWidth/)
  assert.doesNotMatch(uniformWriter, /new ArrayBuffer/)
})
