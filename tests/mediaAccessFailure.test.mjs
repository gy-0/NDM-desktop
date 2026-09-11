import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaAccessMessage, MediaAccessFailure } from '../src/renderer/src/lib/mediaAccessFailure.ts'
test('geographic access failure does not offer signing in as a fix', () => {
  assert.match(mediaAccessMessage('regionRestricted'), /地区限制/)
  assert.match(mediaAccessMessage('regionRestricted'), /来源网站/)
  assert.doesNotMatch(mediaAccessMessage('regionRestricted'), /会话重试/)
})
test('entitlement asks users to confirm account access without promising login will grant it', () => {
  const message=mediaAccessMessage('entitlementRequired')
  assert.match(message,/访问权限/)
  assert.match(message,/确认账号权限/)
  assert.doesNotMatch(message,/登录即可|自动授权/)
})
test('only explicit access denial blocks HTML fallback', () => {
  assert.equal(mediaAccessMessage('probeFailed'),null)
  assert.equal(mediaAccessMessage('browserSessionRequired'),null)
  assert.equal(mediaAccessMessage(undefined),null)
  assert.ok(new MediaAccessFailure('regionRestricted') instanceof Error)
})
