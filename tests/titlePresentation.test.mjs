import assert from 'node:assert/strict'
import test from 'node:test'
import { isDistinctTitle } from '../src/renderer/src/lib/format.ts'

test('video titles repeated as filenames are not rendered twice', () => {
  assert.equal(isDistinctTitle('The power of curves', 'The power of curves.mp4'), false)
  assert.equal(isDistinctTitle('The power of curves', 'The_power_of_curves.mp4'), false)
  assert.equal(isDistinctTitle('The power of curves / X', 'The power of curves.mp4'), false)
  assert.equal(isDistinctTitle('Fløki — The power of curves', 'Fløki - The power of curves.mp4'), false)
})

test('a genuinely different page title remains useful context', () => {
  assert.equal(isDistinctTitle('Release notes and installation guide', 'NDM-2026.8.25.dmg'), true)
  assert.equal(isDistinctTitle('Episode 4 · Director commentary', 'Episode 4.mp4'), true)
})
