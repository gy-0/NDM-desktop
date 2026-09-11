import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const gallery = readFileSync('src/renderer/src/Gallery.tsx', 'utf8')

test('gallery consumes the shared theme instead of reviving legacy warm colors', () => {
  assert.match(gallery, /bg-ink text-paper/)
  assert.doesNotMatch(gallery, /#(?:111110|efe8dc|191816)|font-serif|uppercase|rounded-full/)
})
