import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
const segmented = fs.readFileSync('src/renderer/src/components/SegmentedControl.tsx', 'utf8')

test('media choice buttons retain tactile audio feedback', () => {
  const qualityGrid = composer.slice(
    composer.indexOf('mediaFormats.slice(0, 6).map'),
    composer.indexOf("<div className=\"mt-3 grid grid-cols-2", composer.indexOf('mediaFormats.slice(0, 6).map'))
  )
  assert.match(qualityGrid, /data-cuelume-press="tick"/)
  // The MP4/MKV choices are rendered by the shared segmented control; test
  // the reusable interaction contract rather than a stale implementation
  // detail in Composer's options array.
  assert.match(segmented, /data-cuelume-press="tick"/)
  assert.match(composer, /setSelectedSubtitle\(event\.target\.value \|\| null\)[\s\S]*?cue\('tick'\)/)
})
