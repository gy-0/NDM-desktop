import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')

test('Inspector keeps long identity and link content inside stable bounds', () => {
  assert.match(inspector, /line-clamp-3 break-words font-serif/)
  assert.match(inspector, /line-clamp-2 min-h-\[2\.5rem\] max-h-\[2\.5rem\]/)
  assert.doesNotMatch(inspector, /展开完整标题/)
})

test('Inspector source links and storage location are direct click targets', () => {
  assert.match(inspector, /openLabel="在浏览器中打开来源网页"/)
  assert.match(inspector, /openLabel="在浏览器中打开下载链接"/)
  assert.match(inspector, /onOpen=\{handleReveal\}/)
  assert.match(inspector, /openIcon=\{FolderOpen\}/)
  assert.match(inspector, /aria-label=\{openLabel \?\? `打开\$\{label\}`\}/)
  assert.doesNotMatch(inspector, />\s*打开\s*<\/button>/)
})

test('Inspector presents task facts as a compact value summary', () => {
  assert.match(inspector, /const summaryFacts = \[/)
  assert.match(inspector, /!completed \? \{ label: '进度'/)
  assert.doesNotMatch(inspector, /<Fact label="状态"/)
  assert.doesNotMatch(inspector, /function Fact\(/)
})

test('Inspector footer actions use quiet local hover surfaces', () => {
  assert.match(inspector, /hover:bg-paper\/\[0\.045\]/)
  assert.match(inspector, /border border-transparent/)
})
