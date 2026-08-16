import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  categoryForFilename,
  clampConnections,
  isSupportedDownloadUrl,
  nameFromDownloadUrl,
  sanitizeWindowsFilename,
  segmentSnapshot,
  sourceFromDownloadUrl
} from '../src/main/windows/engineCore.ts'

test('Windows filenames remove forbidden characters and reserved devices', () => {
  assert.equal(sanitizeWindowsFilename('report:final?.pdf'), 'report_final_.pdf')
  assert.equal(sanitizeWindowsFilename('CON'), '_CON')
  assert.equal(sanitizeWindowsFilename('movie.mp4.  '), 'movie.mp4')
})

test('magnet display name and source are preserved', () => {
  const magnet = 'magnet:?xt=urn:btih:abc&dn=旅行%20照片'
  assert.equal(nameFromDownloadUrl(magnet, 9), '旅行 照片')
  assert.equal(sourceFromDownloadUrl(magnet), 'BitTorrent')
})

test('Windows engine accepts real download transports only', () => {
  assert.equal(isSupportedDownloadUrl('https://example.com/a.zip'), true)
  assert.equal(isSupportedDownloadUrl('ftp://example.com/a.iso'), true)
  assert.equal(isSupportedDownloadUrl('magnet:?xt=urn:btih:abc'), true)
  assert.equal(isSupportedDownloadUrl('file:///C:/private.txt'), false)
})

test('connection and progress snapshots stay within aria2 limits', () => {
  assert.equal(clampConnections(32), 16)
  const segments = segmentSnapshot(32, 1.4)
  assert.equal(segments.length, 16)
  assert.ok(segments.every((segment) => segment.fraction === 1))
})

test('common Windows downloads receive the right category', () => {
  assert.equal(categoryForFilename('setup.msi'), 'application')
  assert.equal(categoryForFilename('photos.zip'), 'compressed')
  assert.equal(categoryForFilename('clip.mp4'), 'video')
})
