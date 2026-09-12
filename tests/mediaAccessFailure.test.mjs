import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaAccessMessage, MediaAccessFailure, requiresResolvedMedia } from '../src/renderer/src/lib/mediaAccessFailure.ts'
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
test('recognized media pages stay blocked until a format has been resolved', () => {
  const url='https://www.youtube.com/watch?v=fixture'
  assert.equal(requiresResolvedMedia(url,null),true)
  assert.equal(requiresResolvedMedia(url,'http-720p'),false)
  assert.equal(requiresResolvedMedia('看看这个视频 https://www.youtube.com/watch?v=fixture',null),true)
})
test('direct files and generic URLs retain their ordinary-download fallback', () => {
  for(const url of ['https://files.example.com/archive.zip','https://youtube.com/archive.zip','https://files.example.com/video.mp4','https://files.example.com/unknown-resource','magnet:?xt=urn:btih:fixture','']) {
    assert.equal(requiresResolvedMedia(url,null),false,url)
  }
})
