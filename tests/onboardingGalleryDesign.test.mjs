import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const onboarding = readFileSync('src/renderer/src/components/Onboarding.tsx', 'utf8')
const gallery = readFileSync('src/renderer/src/Gallery.tsx', 'utf8')

test('onboarding behaves like a setup assistant instead of a marketing page', () => {
  assert.doesNotMatch(onboarding, /BorderBeam|radial-gradient|backdrop-blur|font-serif|uppercase/)
  assert.doesNotMatch(onboarding, /rounded-full|active:scale|bg-copper\/14/)
  assert.match(onboarding, /第 \{step \+ 1\} 步，共 \{STEP_COUNT\} 步/)
  assert.match(onboarding, /title="数据保存在本机"/)
})

test('gallery consumes the shared theme instead of reviving legacy warm colors', () => {
  assert.match(gallery, /bg-ink text-paper/)
  assert.doesNotMatch(gallery, /#(?:111110|efe8dc|191816)|font-serif|uppercase|rounded-full/)
})
