import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildMediaFormatTiers,
  isPlayableMediaInfo,
  isYouTubeMediaURL,
  mediaDownloadArguments,
  parseYtDlpDestinationLine,
  parseYtDlpProgressLine,
  requiresMediaMerge
} from '../src/main/windows/mediaFormats.ts'

const formats = [
  {
    format_id: '137', height: 1080, format_note: '1080p', ext: 'mp4',
    vcodec: 'avc1.640028', acodec: 'none', filesize: 80_000_000, tbr: 2200
  },
  {
    format_id: '399', height: 1080, format_note: '1080p', ext: 'mp4',
    vcodec: 'av01.0.08M.08', acodec: 'none', filesize: 42_000_000, tbr: 1300
  },
  {
    format_id: '616', height: 1080, format_note: '1080p Premium', ext: 'mp4',
    vcodec: 'vp9', acodec: 'none', filesize: 120_000_000, tbr: 5800
  },
  {
    format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2',
    filesize: 8_000_000, abr: 128
  },
  {
    format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus',
    filesize: 7_000_000, abr: 160
  }
]

test('Windows media tiers expose exact compatible and compact stream pairs', () => {
  const tiers = buildMediaFormatTiers(formats, 180, {
    allowMerging: true,
    includeYouTubeHighBitrate: true
  })
  assert.deepEqual(tiers.map((tier) => tier.label), ['1080p 高码率', '1080p'])
  assert.equal(tiers[0].compatibleSelector, '616+140')
  assert.equal(tiers[0].isHighBitrate, true)
  assert.equal(tiers[1].compatibleSelector, '137+140')
  assert.equal(tiers[1].compactSelector, '399+251')
  assert.equal(tiers[1].approximateBytes, 88_000_000)
  assert.equal(tiers[1].compactApproximateBytes, 49_000_000)
})

test('high-bitrate labels are restricted to an actual YouTube source', () => {
  const generic = buildMediaFormatTiers(formats, 180, { allowMerging: true })
  assert.deepEqual(generic.map((tier) => tier.label), ['1080p'])
  assert.equal(generic[0].compatibleSelector, '137+140')
  const genericPremiumOnly = buildMediaFormatTiers([formats[2], formats[3]], 180, { allowMerging: true })
  assert.deepEqual(genericPremiumOnly.map((tier) => tier.label), ['1080p'])
  assert.equal(genericPremiumOnly[0].compatibleSelector, '616+140')
  assert.equal(isYouTubeMediaURL('https://music.youtube.com/watch?v=abc'), true)
  assert.equal(isYouTubeMediaURL('https://example.com/?next=youtube.com'), false)
})

test('without ffmpeg the Windows picker only promises progressive formats', () => {
  const progressive = buildMediaFormatTiers([
    ...formats,
    {
      format_id: '18', height: 360, ext: 'mp4', url: 'https://cdn.example/video.mp4',
      vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', filesize: 12_000_000
    }
  ])
  assert.deepEqual(progressive.map((tier) => tier.id), ['18'])
  assert.equal(requiresMediaMerge(progressive[0].id), false)
})

test('generic extractor output for a non-media attachment is rejected', () => {
  assert.equal(isPlayableMediaInfo({ ext: 'gguf', vcodec: 'none', acodec: 'none' }), false)
  assert.equal(isPlayableMediaInfo({ ext: 'unknown_video' }), false)
  assert.equal(isPlayableMediaInfo({ ext: 'mp4', vcodec: 'avc1', acodec: 'aac' }), true)
})

test('merged media arguments carry delivery, resume, proxy, limits and subtitles', () => {
  const args = mediaDownloadArguments({
    pageURL: 'https://example.com/manifest.mpd',
    selector: 'video+audio',
    outputPath: 'C:\\Downloads\\Movie.mkv',
    container: 'compactMKV',
    ffmpegPath: 'C:\\Tools\\ffmpeg.exe',
    connections: 32,
    subtitleLanguage: 'zh-Hans',
    cookieBrowser: 'chrome',
    proxy: 'http://127.0.0.1:7890',
    bandwidthLimit: 2_000_000
  })
  assert.deepEqual(args.slice(0, 4), ['-f', 'video+audio', '--merge-output-format', 'mkv'])
  assert.ok(args.includes('--continue'))
  assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '16')
  assert.equal(args[args.indexOf('--limit-rate') + 1], '2000000')
  assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:7890')
  assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'chrome')
  assert.equal(args[args.indexOf('--sub-langs') + 1], 'zh-Hans')
})

test('machine progress and final destination lines parse without human log heuristics', () => {
  assert.deepEqual(
    parseYtDlpProgressLine('NDM_PROGRESS|1048576|0|2097152|524288|137|downloading'),
    {
      downloadedBytes: 1_048_576,
      totalBytes: 2_097_152,
      bytesPerSecond: 524_288,
      componentID: '137',
      status: 'downloading'
    }
  )
  assert.equal(parseYtDlpDestinationLine('NDM_DEST|C:\\Downloads\\Movie.mp4'), 'C:\\Downloads\\Movie.mp4')
  assert.equal(parseYtDlpProgressLine('[download] 50%'), null)
})
