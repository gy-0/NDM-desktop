import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleMediaFormats } from '../src/renderer/src/lib/mediaChoices.ts'

const formats = Array.from({ length: 9 }, (_, index) => ({ id: `quality-${index}` }))

test('expanding qualities exposes every format returned by the engine', () => {
  assert.deepEqual(visibleMediaFormats(formats, formats[0].id, true), formats)
  assert.equal(visibleMediaFormats(formats, formats[0].id, false).length, 6)
})

test('folding qualities keeps a selected format beyond the initial six visible', () => {
  const visible = visibleMediaFormats(formats, formats[8].id, false)
  assert.deepEqual(visible, [...formats.slice(0, 5), formats[8]])
  assert.equal(new Set(visible.map(format => format.id)).size, 6)
  assert.equal(formats.length, 9)
})

test('missing and short quality selections preserve the engine ordering', () => {
  assert.deepEqual(visibleMediaFormats(formats, 'previous-video-quality', false), formats.slice(0, 6))
  assert.deepEqual(visibleMediaFormats(formats.slice(0, 3), null, false), formats.slice(0, 3))
  assert.deepEqual(visibleMediaFormats([], null, true), [])
})
