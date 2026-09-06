import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  filenameStem,
  formatBytes,
  formatDownloadTime,
  formatSpeed,
  fractionOf,
  inferCategory
} from '../src/renderer/src/lib/format.ts'

test('formatBytes scales across byte, KB, MB, GB bands', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(10 * 1024), '10.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB')
})

test('formatBytes drops precision once a band reaches three digits', () => {
  assert.equal(formatBytes(150 * 1024), '150 KB')
  assert.equal(formatBytes(1234 * 1024), '1.2 MB')
})

test('formatSpeed reports KB/s and MB/s with fitting precision', () => {
  assert.deepEqual(formatSpeed(0), { value: '0', unit: 'KB/s' })
  assert.deepEqual(formatSpeed(5 * 1024), { value: '5.0', unit: 'KB/s' })
  assert.deepEqual(formatSpeed(512), { value: '0.5', unit: 'KB/s' })
  assert.deepEqual(formatSpeed(5 * 1024 * 1024), { value: '5.00', unit: 'MB/s' })
  assert.deepEqual(formatSpeed(50 * 1024 * 1024), { value: '50.0', unit: 'MB/s' })
})

test('fractionOf prefers the authoritative progressFraction field', () => {
  assert.equal(fractionOf({ fileSize: 100, completedBytes: 10, progressFraction: 0.9 }), 0.9)
  assert.equal(fractionOf({ fileSize: 100, completedBytes: 10 }), 0.1)
  assert.equal(fractionOf({ fileSize: 0, completedBytes: 10 }), 0)
  assert.equal(fractionOf({ fileSize: 0, completedBytes: 0 }), 0)
})

test('inferCategory maps extensions to the expected buckets', () => {
  assert.equal(inferCategory('movie.mkv'), 'video')
  assert.equal(inferCategory('song.FLAC'), 'audio')
  assert.equal(inferCategory('book.epub'), 'document')
  assert.equal(inferCategory('archive.zip'), 'compressed')
  assert.equal(inferCategory('setup.dmg'), 'application')
  assert.equal(inferCategory('photo.webp'), 'image')
  assert.equal(inferCategory('no-extension'), 'misc')
  assert.equal(inferCategory('archive.tar.gz'), 'compressed')
})

test('filenameStem strips the last extension but keeps dotted stems and whitespace trimmed', () => {
  assert.equal(filenameStem('report.pdf'), 'report')
  assert.equal(filenameStem('archive.tar.gz'), 'archive.tar')
  assert.equal(filenameStem('no-extension'), 'no-extension')
  assert.equal(filenameStem('.hidden'), '.hidden')
  assert.equal(filenameStem('   spaced file.txt  '), 'spaced file')
  assert.equal(filenameStem('важно.doc'), 'важно')
})

test('formatDownloadTime distinguishes today from other dates', () => {
  const now = Date.now()
  const today = formatDownloadTime(now)
  assert.match(today, /^今天 /)

  const laterThisYear = formatDownloadTime(now + 90 * 24 * 60 * 60 * 1000)
  // Within the same year it is "M月D日 时间"; a rollover is "YYYY/M/D".
  assert.ok(/月|今日|\//.test(laterThisYear))
})

test('formatDownloadTime rejects invalid timestamps', () => {
  assert.equal(formatDownloadTime(undefined), '—')
  assert.equal(formatDownloadTime(Number.NaN), '—')
  assert.equal(formatDownloadTime(Number.POSITIVE_INFINITY), '—')
})