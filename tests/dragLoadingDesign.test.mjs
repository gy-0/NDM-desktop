import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const dropOverlay = readFileSync('src/renderer/src/components/DownloadDropTarget.tsx', 'utf8')
const dropCss = readFileSync('src/renderer/src/components/ui/download-drop-target.css', 'utf8')
const loading = readFileSync('src/renderer/src/components/LoadingMark.tsx', 'utf8')
const css = readFileSync('src/renderer/src/index.css', 'utf8')

test('drag feedback is a compact solid target instead of an atmospheric takeover', () => {
  assert.match(app, /<DownloadDropTarget active=\{isDragging\} hot=\{dropTargetHot\} targetRef=\{dropDialogRef\}/)
  assert.match(dropOverlay, /bg-ink\/92/)
  assert.doesNotMatch(dropOverlay, /radial-gradient|backdrop-blur|rounded-\[22px\]|30px_80px|repeat: Infinity|font-serif/)
  assert.match(app, /const handleDragEnter[\s\S]*?clearDropIssue\(\)/)
})

test('drop dialog answers the cursor when it hovers the target', () => {
  // The veil is pointer-events-none, so hover is derived from the drag
  // position against the dialog rect.
  assert.match(app, /dropDialogRef/)
  assert.match(app, /getBoundingClientRect\(\)/)
  assert.match(dropOverlay, /data-drop-hot=\{hot \|\| undefined\}/)
  assert.match(dropCss, /\[data-drop-hot\] rect \{ animation:/)
  assert.match(dropCss, /prefers-reduced-motion: reduce[\s\S]*animation: none/)
  assert.doesNotMatch(dropOverlay, /scale-\[/, 'The receiver hit area and its text must remain stable')
})

test('loading feedback stays legible without animated gradient text', () => {
  assert.match(loading, /text-fog/)
  assert.doesNotMatch(loading, /bg-clip-text|text-transparent|linear-gradient|shimmer-text/)
  assert.doesNotMatch(css, /--animate-gradient|@keyframes gradient|@keyframes shimmer-text/)
})
