import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaAvailabilityNotice } from '../src/renderer/src/lib/mediaAvailability.ts'
test('preview notice accepts only the explicit successful metadata marker', () => {
  assert.equal(mediaAvailabilityNotice('previewOnly'),'previewOnly')
  for(const value of [undefined,null,false,30,'preview','PreviewOnly',{duration:30},'stderr: preview only']) {
    assert.equal(mediaAvailabilityNotice(value),undefined)
  }
})
