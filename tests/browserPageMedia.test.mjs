import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { browserPageMediaURL, readBrowserPageMediaSources, selectedBrowserPageMedia, browserPageMediaError, browserPageMediaPendingConflict, ambiguousBrowserPageMediaSources } from '../src/shared/browserPageMedia.ts'
import { mediaAccessMessage } from '../src/renderer/src/lib/mediaAccessFailure.ts'

const page = 'https://www.douyin.com/video/123456789'
const item = { mediaKey: 'frame-0123456789abcdef', title: '1080p', meta: 'MP4', badge: '', kind: 'video', quality: '1080' }
const source = () => ({ sourceToken: randomUUID(), pageURL: page, title: 'Fixture', browser: 'chrome', incognito: false, items: [{ ...item }] })
test('page lookup requires an explicit https Douyin video identity', () => {
  assert.equal(browserPageMediaURL(page + '?share=1'), page)
  assert.equal(browserPageMediaURL('https://www.douyin.com/jingxuan?modal_id=7684024843209051426'), 'https://www.douyin.com/video/7684024843209051426')
  assert.equal(readBrowserPageMediaSources({ ok: true, sources: [{ ...source(), pageURL: 'https://www.douyin.com/jingxuan?modal_id=123456789' }] }, page).length, 1)
  for (const url of ['https://www.douyin.com/', 'https://www.douyin.com/?modal_id=abc', 'https://www.douyin.com/?modal_id=123&modal_id=456', 'https://douyin.com.evil/video/123', 'http://www.douyin.com/video/123', 'https://user@www.douyin.com/video/123', 'https://www.douyin.com:4430/video/123']) assert.equal(browserPageMediaURL(url), null)
})
test('separate browser sources stay separate; none is implicitly selected', () => {
  const sources = readBrowserPageMediaSources({ ok: true, sources: [source(), source()] }, page)
  assert.equal(sources.length, 2)
  assert.equal(selectedBrowserPageMedia(sources, null, page), null)
  const choice = { pageURL: page, sourceToken: sources[1].sourceToken, mediaKey: item.mediaKey }
  assert.deepEqual(selectedBrowserPageMedia(sources, choice, page), item)
  assert.equal(selectedBrowserPageMedia(sources, choice, page + '0'), null)
  assert.equal(selectedBrowserPageMedia([sources[0]], choice, page), null)
  assert.equal(selectedBrowserPageMedia(sources, { ...choice, mediaKey: item.mediaKey + '1' }, page), null)
})
test('summary decoder rejects credentials, resource URLs, stale pages and malformed versions', () => {
  const rows = [source(), source(), source(), source(), source()]
  rows[0].cookies = 'secret'
  rows[1].items[0].url = 'https://cdn.example/media?token=secret'
  rows[2].pageURL += '0'
  rows[3].items[0].quality = 1080
  rows[4].items.push({ ...item })
  for (const row of rows) assert.throws(() => readBrowserPageMediaSources({ ok: true, sources: [row] }, page))
})
test('site rejection is actionable and transport errors never expose sensitive stderr', () => {
  assert.match(mediaAccessMessage('siteRequestRejected'), /浏览器页面读取/)
  assert.equal(mediaAccessMessage('probeFailed'), null)
  const known = '请更新 NDM Relay 扩展，并刷新已打开的视频页面后重试。'
  assert.equal(browserPageMediaError(new Error('IPC: ' + known)), known)
  assert.doesNotMatch(browserPageMediaError(new Error('download https://cdn.example?token=secret Cookie: sid=private')), /secret|Cookie|https/)
})
test('lost admission reply remains bound to A after closing or editing the form to B', () => {
  const pending = { pageURL: page, sourceToken: randomUUID(), mediaKey: item.mediaKey, creationKey: randomUUID(), connections: 32 }
  assert.equal(browserPageMediaPendingConflict(pending, page), false, 'the same reviewed page may confirm/replay its original key')
  for (const reopenedOrEdited of ['', page + '0', 'https://files.example/video.mp4']) {
    assert.equal(browserPageMediaPendingConflict(pending, reopenedOrEdited), true, 'a new form must not replay A as its own result')
  }
  assert.equal(browserPageMediaPendingConflict(null, page + '0'), false, 'an authoritative receipt settles the old admission before another creation')
})
test('identical browser and page labels require explicit browser-side handoff instead of arbitrary profile indices', () => {
  const a = source(), b = source()
  assert.equal(ambiguousBrowserPageMediaSources([a]), false)
  assert.equal(ambiguousBrowserPageMediaSources([a, b]), true)
  assert.equal(ambiguousBrowserPageMediaSources([a, { ...b, title: 'Different page title' }]), false)
  assert.equal(ambiguousBrowserPageMediaSources([a, { ...b, incognito: true }]), false)
  assert.equal(ambiguousBrowserPageMediaSources([a, { ...b, browser: 'edge' }]), false)
})
