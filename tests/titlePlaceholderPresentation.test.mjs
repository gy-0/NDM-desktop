import assert from 'node:assert/strict'
import test from 'node:test'
import { isDistinctTitle } from '../src/renderer/src/lib/format.ts'

test('browser challenge and loading placeholders are not presented as task titles', () => {
  assert.equal(isDistinctTitle('Just a moment...', 'Folx_Pro_5_34_EDiSO_MacKed.iso'), false)
  assert.equal(isDistinctTitle('页面加载中, 请稍候...', 'Downie_4_12_13_EDiSO.dmg'), false)
  assert.equal(isDistinctTitle('Please wait…', 'archive.zip'), false)
})
