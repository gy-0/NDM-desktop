import assert from 'node:assert/strict'
import test from 'node:test'
import { initialMediaSessionBrowser, mediaSessionBrowserOptions } from '../src/renderer/src/lib/mediaSessionBrowser.ts'
test('media chooser exposes only host-supported sources', () => {
  assert.deepEqual(mediaSessionBrowserOptions().map(option=>option.value).sort(),['brave','chrome','chromium','edge','firefox','safari'])
  assert.ok(!mediaSessionBrowserOptions(true).some(option=>option.value==='safari'))
})
test('supported preference initializes choice without silently replacing unsupported preference', () => {
  assert.equal(initialMediaSessionBrowser('firefox'),'firefox')
  assert.equal(initialMediaSessionBrowser('opera'),null)
  assert.equal(initialMediaSessionBrowser('whale'),null)
  assert.equal(initialMediaSessionBrowser('safari',true),null)
})
