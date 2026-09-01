import assert from 'node:assert/strict'
import test from 'node:test'
import { clampSidebarWidth, defaultSidebarWidth } from '../src/renderer/src/lib/layoutPrefs.ts'

test('sidebar default preserves the original responsive width', () => {
  assert.equal(defaultSidebarWidth(1220), 207)
  assert.equal(defaultSidebarWidth(800), 196)
  assert.equal(defaultSidebarWidth(1600), 216)
})

test('sidebar width stays within the adjustable bounds', () => {
  assert.equal(clampSidebarWidth(120), 196)
  assert.equal(clampSidebarWidth(244.4), 244)
  assert.equal(clampSidebarWidth(400), 288)
})
