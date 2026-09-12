import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// These are source-string locks (like composerProbeReliability.test.mjs): the
// Classifier hints cannot establish whether a video is playable. Only an
// unsuccessful media probe may display its session note as a fallback.
const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')

test('the composer classifies pasted URLs through the server verdict', () => {
  assert.match(composer, /window\.ndm\?\.classifyURL\?\.\(trimmed\)/)
  // Only an affirmative binary server answer skips media probing.
  assert.match(composer, /if \(classified\?\.kind === 'binary'\) \{/)
})

test('session notes do not preempt media resolution', () => {
  assert.doesNotMatch(composer, /if \(classified\?\.sessionNote\)/)
  assert.match(composer, /setProbeError\(classified\?\.sessionNote \?\? null\)/)
})

test('the session-note error renders in the live probe status region', () => {
  assert.match(composer, /aria-describedby=\{probeError \? 'composer-probe-status'/)
  assert.match(composer, /id="composer-probe-status" role="status" aria-live="polite"/)
})
