import assert from 'node:assert/strict'
import test from 'node:test'
import { isAudibleCue } from '../src/renderer/src/lib/soundPolicy.ts'
test('removed navigation, cancellation and release recipes are silent everywhere', () => {
  for (const cue of ['page','droplet','release']) assert.equal(isAudibleCue(cue),false)
  for (const cue of ['press','tick','toggle','success','bloom']) assert.equal(isAudibleCue(cue),true)
})
