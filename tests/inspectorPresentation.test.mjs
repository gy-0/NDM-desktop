import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')

test('Inspector keeps long identity and link content inside stable bounds', () => {
  assert.match(inspector, /line-clamp-3 break-words font-sans/)
  assert.match(inspector, /line-clamp-2/)
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
  assert.match(inspector, /data-inspector-summary/)
  assert.match(inspector, /summaryStatus/)
  assert.match(inspector, /summaryAmount/)
  assert.doesNotMatch(inspector, /<Fact label="状态"/)
  assert.doesNotMatch(inspector, /function Fact\(/)
})

test('Inspector contextual actions use quiet local hover surfaces', () => {
  assert.match(inspector, /hover:bg-paper\/\[0\.045\]/)
  assert.match(inspector, /data-inspector-actions/)
  assert.ok(inspector.indexOf('data-inspector-actions') < inspector.indexOf('label="来源网页"'))
})

test('Inspector keeps one type scale and one control metric', () => {
  // Ten font sizes and eight radii in a 320px pane is what made details read as
  // sloppy. Roles only: title / body / label / meta, control / surface.
  const sizes = [...inspector.matchAll(/text-\[[^\]]*\]/g)].map((match) => match[0])
  assert.deepEqual(sizes, [], `Inspector invented font sizes: ${sizes.join(', ')}`)
  const radii = [...inspector.matchAll(/rounded-\[[^\]]*\]/g)].map((match) => match[0])
  assert.deepEqual(radii, [], `Inspector invented radii: ${radii.join(', ')}`)
  assert.doesNotMatch(inspector, /rounded-(?:xs|sm|md|lg|xl|2xl|3xl)\b/)
  for (const role of ['text-title', 'text-body', 'text-label', 'text-meta']) {
    assert.match(inspector, new RegExp(role), `${role} role is used`)
  }
  assert.match(inspector, /const CONTROL_CLASS = '[^']*h-control/)
  assert.match(inspector, /const UTILITY_ITEM_CLASS = '[^']*h-control/)
  // Every control is 28px (h-control) and every text field is 32px (h-field);
  // the ad-hoc h-7 buttons and h-8 fields this pane used to mix are gone.
  assert.match(inspector, /h-control/)
  assert.match(inspector, /h-field/)
  assert.doesNotMatch(inspector, /(?<![\w-])h-[0-9]+\b/)
})

test('Inspector limit control offers a custom speed and paints the choice at once', () => {
  assert.match(inspector, /BANDWIDTH_PRESETS/)
  assert.match(inspector, /parseLimitInput/)
  assert.match(inspector, /aria-label="自定义任务限速，每秒 MB"/)
  assert.match(inspector, /placeholder="跟随全局"/)
  // Optimistic paint: the tier is selected before the engine acknowledgement,
  // and the acknowledgement still owns the durable value.
  const handler = inspector.match(/const handleTaskBandwidth[\s\S]*?\n  \}/)
  assert.ok(handler, 'task bandwidth handler is present')
  assert.match(handler[0], /setBandwidthDraft\(bandwidthLimit\)[\s\S]*?await setTaskBandwidth\(task.id, bandwidthLimit\)/)
  assert.match(handler[0], /catch \{[\s\S]*?setBandwidthDraft\(null\)/)
  // The old four-tier segmented control (with 8.5px unit suffixes) is gone.
  assert.doesNotMatch(inspector, /SegmentedControl/)
  assert.doesNotMatch(inspector, /text-\[8\.5px\]/)
})
