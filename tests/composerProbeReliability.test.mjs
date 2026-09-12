import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')

test('media probing exits its busy state and explains engine failures', () => {
  assert.match(composer, /probeMedia\(trimmed, undefined, browserSession\?\.id, browserSession\?\.browser\)\.then[\s\S]*?\.catch\(\(\) => \{[\s\S]*?setProbing\(false\)/)
  assert.match(composer, /未能解析链接，请重试或选择普通下载。/)
  assert.match(composer, /probeMedia\(target, relay \? undefined : \(browser \|\| undefined\), relay\?\.id, relay\?\.browser\)\.then[\s\S]*?\.catch\(\(\) => \{/)
  assert.match(composer, /findDuplicate\(\[trimmed\]\)[\s\S]*?\.catch\(\(\) =>/)
  assert.match(store, /const status = await window\.ndm\?\.status\(\)\.catch\(\(\) => 'down'\)/)
  assert.match(store, /if \(status !== 'live'\) throw new Error\('媒体分析服务不可用'\)/)
})

test('media probe errors are visible and associated with the URL field', () => {
  assert.match(composer, /aria-describedby=\{probeError \? 'composer-probe-status'/)
  assert.match(composer, /id="composer-probe-status" role="status" aria-live="polite"/)
})
