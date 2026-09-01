import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')

test('clipboard handoff consumes the detected value before opening composer', () => {
  const handler = /onDownload=\{\(url\) => \{([\s\S]*?)\n\s*\}\}/.exec(app)?.[1] ?? ''
  assert.match(handler, /consumeGeneration\(\)/)
  assert.match(handler, /openComposer\(url\)/)
  assert.ok(handler.indexOf('consumeGeneration()') < handler.indexOf('openComposer(url)'))
})

test('adding a download without a prefill consumes the current clipboard generation', () => {
  const opener = /const openComposer = \(prefillUrl\?: string\): void => \{([\s\S]*?)\n  \}/.exec(app)?.[1] ?? ''
  assert.match(opener, /if \(!prefillUrl\) void clipboard\.consumeGeneration\(\)/)
  assert.match(opener, /setComposing\(true\)/)
  assert.ok(opener.indexOf('consumeGeneration()') < opener.indexOf('setComposing(true)'))
})

test('composer auto-fill reports the clipboard URL as consumed', () => {
  assert.match(composer, /onClipboardConsumedRef\.current\?\.\(\)/)
  assert.match(composer, /onClipboardConsumed\?: \(\) => void/)
})
