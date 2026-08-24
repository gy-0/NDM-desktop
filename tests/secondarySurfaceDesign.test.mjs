import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const surfaces = [
  'CleanupModal',
  'ProModal',
  'ShortcutsOverlay',
  'DeleteTasksDialog',
  'ClipboardToast',
  'CompletionBar'
].map((name) => ({
  name,
  source: readFileSync(`src/renderer/src/components/${name}.tsx`, 'utf8')
}))
const css = readFileSync('src/renderer/src/index.css', 'utf8')

test('semantic accent utility resolves to the active theme token', () => {
  assert.match(css, /--color-accent:\s*var\(--accent\)/)
})

test('secondary surfaces use solid compact elevation instead of atmospheric effects', () => {
  for (const { name, source } of surfaces) {
    assert.doesNotMatch(source, /radial-gradient|backdrop-blur|28px_80px|rounded-\[20px\]/, name)
  }
})

test('secondary surfaces do not animate borders, text, or button scale for decoration', () => {
  for (const { name, source } of surfaces) {
    assert.doesNotMatch(source, /BorderBeam|AnimatedShinyText|active:scale|rounded-full/, name)
  }
})

test('operational dialog titles stay in the system UI voice', () => {
  for (const { name, source } of surfaces.slice(0, 4)) {
    assert.doesNotMatch(source, /font-serif|uppercase/, name)
  }
})
