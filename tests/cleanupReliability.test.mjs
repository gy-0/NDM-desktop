import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const cleanup = fs.readFileSync('src/renderer/src/components/CleanupModal.tsx', 'utf8')

test('cleanup reports acknowledged counts and partial retries honestly', () => {
  assert.match(cleanup, /const count = await restartMany\(bucket\.ids\)/)
  assert.match(cleanup, /retried: \(current\?\.retried \?\? 0\) \+ count/)
  assert.match(cleanup, /if \(count !== bucket\.ids\.length\)/)
  assert.match(cleanup, /只重试了 \$\{count\}\/\$\{bucket\.ids\.length\} 个失败任务/)
  assert.match(cleanup, /const count = await removeMany\(bucket\.ids, false\)/)
  assert.match(cleanup, /removed: \(current\?\.removed \?\? 0\) \+ count/)
})

test('cleanup failures stay visible, associated and retryable', () => {
  assert.match(cleanup, /catch \(error\)[\s\S]*?setErrors/)
  assert.match(cleanup, /error\.message\.startsWith\('只删除了 '\)/)
  assert.match(cleanup, /未能移出\$\{bucket\.label\}。请检查下载引擎后重试。/)
  assert.match(cleanup, /role="status"[\s\S]*?aria-live="polite"/)
  assert.match(cleanup, /aria-describedby=\{errors\[bucket\.id\]/)
  assert.match(cleanup, /disabled=\{anyBusy\}/)
  assert.match(cleanup, /aria-busy=\{anyBusy\}/)
  assert.match(cleanup, /if \(anyBusy\) return/)
})
