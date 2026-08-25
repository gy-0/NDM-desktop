import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')

test('media choice buttons retain tactile audio feedback', () => {
  const qualityGrid = composer.slice(
    composer.indexOf('mediaFormats.slice(0, 6).map'),
    composer.indexOf("<div className=\"mt-3 grid grid-cols-2", composer.indexOf('mediaFormats.slice(0, 6).map'))
  )
  const containerGrid = composer.slice(
    composer.indexOf("['compatibleMP4', 'MP4'"),
    composer.indexOf('</div>\n                  </div>', composer.indexOf("['compatibleMP4', 'MP4'"))
  )

  assert.match(qualityGrid, /data-cuelume-press="tick"/)
  assert.match(containerGrid, /data-cuelume-press="tick"/)
  assert.match(composer, /setSelectedSubtitle\(event\.target\.value \|\| null\)[\s\S]*?cue\('tick'\)/)
})
