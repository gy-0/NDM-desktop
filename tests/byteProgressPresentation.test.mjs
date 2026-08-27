import assert from 'node:assert/strict'
import test from 'node:test'
import { formatByteProgress } from '../src/renderer/src/lib/format.ts'

test('byte progress formats a known total as real byte counts', () => {
  assert.equal(formatByteProgress(60_870_828, 149_632_020), '58.1 MB / 143 MB')
})

test('byte progress names an unknown total instead of formatting zero bytes', () => {
  assert.equal(formatByteProgress(60_870_828, 0), '58.1 MB / 大小计算中')
  assert.equal(formatByteProgress(0, 0), '大小计算中')
})
