import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')

test('clipboard handoff consumes the detected value before opening composer', () => {
  const handler = /onDownload=\{\(url\) => \{([\s\S]*?)\n\s*\}\}/.exec(app)?.[1] ?? ''
  assert.match(handler, /setDismissedClipUrl\(url\)/)
  assert.match(handler, /setClipboardUrl\(null\)/)
  assert.match(handler, /openComposer\(url\)/)
  assert.ok(handler.indexOf('setDismissedClipUrl(url)') < handler.indexOf('openComposer(url)'))
})
