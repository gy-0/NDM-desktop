import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaAccessMessage, MediaAccessFailure } from '../src/renderer/src/lib/mediaAccessFailure.ts'
test('geographic access failure does not offer signing in as a fix', () => {
  assert.match(mediaAccessMessage('regionRestricted'), /可访问地区/)
  assert.match(mediaAccessMessage('regionRestricted'), /确认可用范围/)
  assert.doesNotMatch(mediaAccessMessage('regionRestricted'), /会话重试/)
})
test('entitlement asks for source permission and only offers explicit session reuse conditionally', () => {
  const message=mediaAccessMessage('entitlementRequired')
  assert.match(message,/访问权限/)
  assert.match(message,/如果浏览器中可以播放/)
  assert.match(message,/自行选择/)
})
test('only explicit access denial blocks HTML fallback', () => {
  assert.equal(mediaAccessMessage('probeFailed'),null)
  assert.equal(mediaAccessMessage('browserSessionRequired'),null)
  assert.equal(mediaAccessMessage(undefined),null)
  assert.ok(new MediaAccessFailure('regionRestricted') instanceof Error)
})
