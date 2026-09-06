import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractSharedLinks,
  isKnownMediaSiteURL,
  resolveSharedLink,
  sharedLinkSourceForURL
} from '../src/renderer/src/lib/sharedLink.ts'

const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=NDM%20Test'

test('magnet links are accepted as first-class download input', () => {
  assert.deepEqual(resolveSharedLink(magnet), {
    urlString: magnet,
    source: 'magnet',
    wasExtractedFromText: false
  })
})

test('magnet links are extracted from surrounding Chinese share text', () => {
  const matches = extractSharedLinks(`给你这个磁力链：${magnet}，下载看看`)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].urlString, magnet)
  assert.equal(matches[0].source, 'magnet')
  assert.equal(matches[0].wasExtractedFromText, true)
})

test('unsupported URI schemes are ignored', () => {
  assert.equal(resolveSharedLink('file:///C:/secret.txt'), null)
})

test('media site URLs map to their expected sources', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://b23.tv/ab12cd3', 'bilibili'],
    ['https://v.douyin.com/AbCdEf/', 'douyin'],
    ['https://www.douyin.com/video/7300000000000000000', 'douyin'],
    ['https://www.iesdouyin.com/share/video/7300000000000000000', 'douyin'],
    ['https://www.xiaohongshu.com/explore/abc123', 'xiaohongshu'],
    ['https://xhslink.com/AbCdEf', 'xiaohongshu'],
    ['https://vm.tiktok.com/ZMabcdef/', 'tiktok'],
    ['https://www.tiktok.com/@user/video/7300000000000000000', 'tiktok'],
    ['https://v.kuaishou.com/AbCdEf', 'kuaishou'],
    ['https://www.kuaishou.com/short-video/3xabcdef', 'kuaishou'],
    ['https://weibo.com/tv/show/1034:abc', 'weibo'],
    ['https://weibo.cn/some/status', 'weibo'],
    ['https://www.instagram.com/reel/AbCdEf/', 'instagram'],
    ['https://x.com/user/status/1234567890', 'x'],
    ['https://twitter.com/user/status/1234567890', 'x'],
    ['https://fb.watch/abcdef/', 'facebook'],
    ['https://www.facebook.com/watch?v=12345', 'facebook'],
    ['https://vimeo.com/123456789', 'vimeo'],
    ['https://www.twitch.tv/videos/123456789', 'twitch'],
    ['https://dai.ly/x8abcde', 'dailymotion'],
    ['https://www.dailymotion.com/video/x8abcde', 'dailymotion']
  ]
  for (const [url, source] of cases) {
    assert.equal(sharedLinkSourceForURL(url), source, url)
    assert.equal(isKnownMediaSiteURL(url), true, url)
  }
})

test('subdomains of media hosts keep their source while lookalike hosts fall back to web', () => {
  assert.equal(sharedLinkSourceForURL('https://music.youtube.com/watch?v=abc'), 'youtube')
  assert.equal(sharedLinkSourceForURL('https://live.bilibili.com/12345'), 'bilibili')
  assert.equal(sharedLinkSourceForURL('https://notyoutube.com/watch?v=abc'), 'web')
  assert.equal(sharedLinkSourceForURL('https://youtube.com.evil.example/watch'), 'web')
  assert.equal(sharedLinkSourceForURL('https://example.com/some/page'), 'web')
  assert.equal(isKnownMediaSiteURL('https://example.com/some/page'), false)
})

test('ezproxy institutional links are treated as plain web, not media sites', () => {
  const ezproxyZip =
    'https://ezproxy.library.mcmaster.ca/login?url=https%3A%2F%2Fwww.cambridge.org%2Ffiles%2Fdownloads%2Fsomething.zip'
  assert.equal(sharedLinkSourceForURL(ezproxyZip), 'web')
  assert.equal(isKnownMediaSiteURL(ezproxyZip), false)
})

test('bare known hosts without a scheme are extracted with an https prefix', () => {
  const matches = extractSharedLinks('快看这个：bilibili.com/video/BV1xx411c7mD 转发一下')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].urlString, 'https://bilibili.com/video/BV1xx411c7mD')
  assert.equal(matches[0].source, 'bilibili')
  assert.equal(matches[0].wasExtractedFromText, true)
})

test('extraction normalizes fullwidth characters, zero-width joiners and HTML entities', () => {
  const fullwidth = 'https://ｗｗｗ．ｂｉｌｉｂｉｌｉ．ｃｏｍ／ｖｉｄｅｏ／ＢＶ１xx411c7mD'
  const matches = extractSharedLinks(`下载地址\u200B${fullwidth}\uFEFF 不要客气`)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].urlString, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(matches[0].source, 'bilibili')

  const entity = 'https://www.youtube.com/watch?utm_source=share&amp;v=dQw4w9WgXcQ'
  assert.equal(resolveSharedLink(entity)?.urlString, 'https://www.youtube.com/watch?utm_source=share&v=dQw4w9WgXcQ')
  assert.equal(resolveSharedLink(entity)?.source, 'youtube')
})

test('extraction trims trailing punctuation but keeps inner punctuation', () => {
  const matches = extractSharedLinks('链接：https://youtu.be/dQw4w9WgXcQ，谢谢')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].urlString, 'https://youtu.be/dQw4w9WgXcQ')

  const amp = extractSharedLinks('链接：https://youtu.be/dQw4w9WgXcQ?si=abc')
  assert.equal(amp[0].urlString, 'https://youtu.be/dQw4w9WgXcQ?si=abc')
})

test('invalid or empty inputs never throw', () => {
  assert.deepEqual(extractSharedLinks(''), [])
  assert.deepEqual(extractSharedLinks('   '), [])
  assert.deepEqual(extractSharedLinks('这里没有链接，只是随口说说。'), [])
  // The renderer does not validate magnet hashes (engine-side concern): any
  // magnet:? URL is handed through, so the contract is only "never throws".
  assert.deepEqual(extractSharedLinks('magnet:?xt=urn:btih:notahexhash'), [
    { urlString: 'magnet:?xt=urn:btih:notahexhash', source: 'magnet', wasExtractedFromText: false }
  ])
  assert.deepEqual(extractSharedLinks('magnet:'), [])
  assert.equal(resolveSharedLink('not a url at all'), null)
  assert.equal(resolveSharedLink('https://'), null)
  assert.equal(isKnownMediaSiteURL('不是链接的文本'), false)
  assert.equal(isKnownMediaSiteURL('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), false)
})
