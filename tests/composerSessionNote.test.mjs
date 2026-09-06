import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// These are source-string locks (like composerProbeReliability.test.mjs): the
// composer must surface the classifier's session note instead of pretending a
// login-walled page is a probeable video.
const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')

test('the composer classifies pasted URLs through the server verdict', () => {
  assert.match(composer, /window\.ndm\?\.classifyURL\?\.\(trimmed\)/)
  // A binary/unknown server answer skips media probing entirely.
  assert.match(composer, /if \(classified && classified\.kind !== 'html'\) \{/)
})

test('session notes stop the spinner and surface as a probe error', () => {
  assert.match(composer, /if \(classified\?\.sessionNote\) \{[\s\S]*?setProbing\(false\)[\s\S]*?setProbeError\(classified\.sessionNote\)/)
})

test('the session-note error renders in the live probe status region', () => {
  assert.match(composer, /aria-describedby=\{probeError \? 'composer-probe-status'/)
  assert.match(composer, /id="composer-probe-status" role="status" aria-live="polite"/)
})
