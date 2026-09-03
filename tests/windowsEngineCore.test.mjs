import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  categoryForFilename,
  clampConnections,
  isSupportedDownloadUrl,
  nameFromDownloadUrl,
  ownedTaskArtifactNames,
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

test('restartMany is wired per-engine and never aborts the batch on one bad row', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync('src/main/windows/windowsEngine.ts', 'utf8')
  // Op routing exists alongside the single restart.
  assert.match(source, /case 'restartMany': return this\.restartMany\(extra\)/)
  // The batch loop isolates failures instead of failing the whole cleanup.
  const impl = source.match(/private async restartMany[\s\S]*?\n  \}/)
  assert.ok(impl, 'restartMany implementation present')
  assert.match(impl[0], /try \{[\s\S]*?await this\.withTaskOperation\(id, \(\) => this\.restart\(id\)\)[\s\S]*?\} catch/)
  assert.match(impl[0], /count \+= 1/)
})

test('windowsEngine invalidates old aria work before awaiting and serializes polling', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync('src/main/windows/windowsEngine.ts', 'utf8')
  const stop = source.match(/private async stopTask[\s\S]*?\n  \}/)
  assert.ok(stop, 'stopTask implementation present')
  assert.ok(
    stop[0].indexOf('task.gid = undefined') < stop[0].indexOf('await this.stopMediaTask'),
    'old gid must be invalidated before the first lifecycle await'
  )
  assert.match(source, /if \(this\.stopped \|\| this\.pollInFlight\) return/)
  assert.match(source, /this\.ariaStatusApplications\.set\(task\.id, application\)/)
  assert.match(source, /private async withTaskOperation<T>/)
  assert.match(source, /removeTaskArtifacts\(task, true, true\)/)
})

test('artifact ownership is exact in a shared destination directory', () => {
  assert.deepEqual(ownedTaskArtifactNames('movie.mp4', false), [
    'movie.mp4.aria2',
    'movie.mp4.part',
    'movie.mp4.ytdl'
  ])
  assert.deepEqual(ownedTaskArtifactNames('movie.mp4', true), [
    'movie.mp4',
    'movie.mp4.aria2',
    'movie.mp4.part',
    'movie.mp4.ytdl'
  ])

  const owned = new Set(ownedTaskArtifactNames('movie.mp4', false))
  for (const userFile of [
    'movie.f137.notes.txt',
    'movie.family.video.mp4',
    'movie.f140.m4a',
    'movie.part'
  ]) {
    assert.equal(owned.has(userFile), false, `${userFile} must remain user-owned`)
  }
})
