import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalClipboardKey,
  decideClipboardOffer,
  isClipboardDownloadCandidate,
  libraryHasClipboardUrl,
  resolveClipboardCandidate
} from '../src/renderer/src/lib/clipboardOffer.ts'
import { resolveSharedLink } from '../src/renderer/src/lib/sharedLink.ts'

const fileUrl = 'https://cdn.example.com/NDM.dmg'
const youtube = 'https://www.youtube.com/watch?v=abc123'
const youtubeShare = 'https://youtu.be/abc123?si=share-token'

test('file URLs and media sites are clipboard download candidates', () => {
  assert.equal(isClipboardDownloadCandidate(resolveSharedLink(fileUrl)), true)
  assert.equal(isClipboardDownloadCandidate(resolveSharedLink(youtube)), true)
  assert.equal(isClipboardDownloadCandidate(resolveSharedLink('https://example.com/about')), false)
})

test('YouTube share variants collapse to the same library key', () => {
  assert.equal(canonicalClipboardKey(youtubeShare), canonicalClipboardKey(youtube))
  assert.equal(
    libraryHasClipboardUrl([{ url: 'https://cdn.example.com/stream.m4s', pageURL: youtube }], youtubeShare),
    true
  )
})

test('the same pasteboard generation is not offered again after consume', () => {
  assert.deepEqual(
    decideClipboardOffer({
      changeCount: 12,
      handledChangeCount: 12,
      lastObservedChangeCount: 12,
      urlString: fileUrl,
      inLibrary: false,
      selfWritten: false,
      composerOpen: false,
      offeredUrl: null
    }),
    { kind: 'keep' }
  )
})

test('a leftover clipboard URL already in the library is consumed silently', () => {
  assert.deepEqual(
    decideClipboardOffer({
      changeCount: 12,
      handledChangeCount: null,
      lastObservedChangeCount: null,
      urlString: fileUrl,
      inLibrary: true,
      selfWritten: false,
      composerOpen: false,
      offeredUrl: null
    }),
    { kind: 'hide' }
  )
})

test('re-copying an existing URL is a new intent and may be offered again', () => {
  assert.deepEqual(
    decideClipboardOffer({
      changeCount: 13,
      handledChangeCount: 12,
      lastObservedChangeCount: 12,
      urlString: fileUrl,
      inLibrary: true,
      selfWritten: false,
      composerOpen: false,
      offeredUrl: null
    }),
    { kind: 'show', urlString: fileUrl }
  )
})

test('opening the composer or writing the clipboard ourselves suppresses the toast', () => {
  const base = {
    changeCount: 8,
    handledChangeCount: null,
    lastObservedChangeCount: null,
    urlString: fileUrl,
    inLibrary: false,
    offeredUrl: null
  }
  assert.deepEqual(decideClipboardOffer({ ...base, selfWritten: true, composerOpen: false }), { kind: 'hide' })
  assert.deepEqual(decideClipboardOffer({ ...base, selfWritten: false, composerOpen: true }), { kind: 'hide' })
})

test('a fresh unused download link is offered', () => {
  assert.deepEqual(
    decideClipboardOffer({
      changeCount: 3,
      handledChangeCount: null,
      lastObservedChangeCount: null,
      urlString: fileUrl,
      inLibrary: false,
      selfWritten: false,
      composerOpen: false,
      offeredUrl: null
    }),
    { kind: 'show', urlString: fileUrl }
  )
})

test('share-command text still resolves to a download candidate', () => {
  const resolution = resolveClipboardCandidate('3.21 复制打开抖音，看看【示例】 https://v.douyin.com/abc123/ 08/09')
  assert.equal(resolution?.source, 'douyin')
  assert.equal(resolution?.urlString, 'https://v.douyin.com/abc123/')
})
