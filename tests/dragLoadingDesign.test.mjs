import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const loading = readFileSync('src/renderer/src/components/LoadingMark.tsx', 'utf8')
const css = readFileSync('src/renderer/src/index.css', 'utf8')

test('drag feedback is a compact solid target instead of an atmospheric takeover', () => {
  const start = app.indexOf('{isDragging ? (')
  const end = app.indexOf('{dropIssue ? (')
  assert.ok(start >= 0 && end > start)
  const dropOverlay = app.slice(start, end)

  assert.match(dropOverlay, /bg-ink\/92/)
  assert.doesNotMatch(dropOverlay, /radial-gradient|backdrop-blur|rounded-\[22px\]|30px_80px|repeat: Infinity|font-serif/)
  assert.match(app, /const handleDragEnter[\s\S]*?clearDropIssue\(\)/)
})

test('loading feedback stays legible without animated gradient text', () => {
  assert.match(loading, /text-fog/)
  assert.doesNotMatch(loading, /bg-clip-text|text-transparent|linear-gradient|shimmer-text/)
  assert.doesNotMatch(css, /--animate-gradient|@keyframes gradient|@keyframes shimmer-text/)
})
