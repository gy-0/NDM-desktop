import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const productMotion = fs.readFileSync('src/renderer/src/effects/metalforge/ProductMotion.tsx', 'utf8')
const hero = fs.readFileSync('src/renderer/src/components/Hero.tsx', 'utf8')
const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const engine = fs.readFileSync('src/renderer/src/effects/metalforge/webgpu.ts', 'utf8')

test('MetalForge effects are attached to meaningful product moments', () => {
  assert.match(productMotion, /effect_01\.wgsl\?raw/)
  assert.match(productMotion, /effect_22\.wgsl\?raw/)
  assert.match(productMotion, /name: 'Slosh'/)
  assert.match(productMotion, /style: 1, progress: 0, alive: 1, warp: 0/)
  assert.match(productMotion, /clockUniform: 'warp'/)
  assert.match(hero, /<TransferField progressFraction=\{fraction\}/)
  assert.match(app, /dragAcceptsLink \? <DropField \/>/)
  assert.doesNotMatch(productMotion, /CompletionField|Glass Orb|effect_08\.wgsl/)
  assert.doesNotMatch(app, /<CompletionField/)
})

test('product shader motion respects reduced motion and avoids per-frame allocation', () => {
  assert.match(productMotion, /prefers-reduced-motion: reduce/)
  assert.match(productMotion, /paused: reducedMotion/)
  assert.match(engine, /let sharedDevice: Promise<GPUDevice> \| null = null/)
  assert.match(engine, /const uniformData = new ArrayBuffer\(uniformSize\)/)
  assert.match(engine, /opts\.clockUniform/)
  assert.match(engine, /opts\.maxPixelRatio/)
  assert.doesNotMatch(engine, /function writeUniforms\(\)[\s\S]*?new ArrayBuffer/)
})
