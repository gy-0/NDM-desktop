import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')
const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const row = fs.readFileSync('src/renderer/src/components/TaskRow.tsx', 'utf8')

test('a failed download is explained on the pane surface instead of a red panel', () => {
  const block = inspector.match(/<section data-download-failure[\s\S]*?<\/section>/)
  assert.ok(block, 'the failure explanation is rendered')
  // The panel used to be a red-washed rounded box (border-clay/30 bg-clay/10):
  // the generic alert look the user rejected. Severity now rides on one mark.
  assert.doesNotMatch(block[0], /bg-clay|border-clay/, 'the explanation keeps the pane surface')
  assert.match(block[0], /text-clay/, 'the mark carries the hue')
  assert.doesNotMatch(block[0], /rounded-(?:lg|xl|surface)/, 'no nested alert card')
  // Structure is the same everywhere: what happened, why, then what to do.
  assert.match(block[0], /task\.diagnostic\?\.title[\s\S]*?task\.diagnostic\?\.message/, 'title precedes the reason')
})

test('install failures and status bands share that quiet grammar', () => {
  const install = inspector.match(/data-inspector-install-error[\s\S]*?\n      \) : null\}/)
  assert.ok(install, 'the install failure note is rendered')
  assert.doesNotMatch(install[0], /bg-clay|border-clay/)
  assert.match(install[0], /text-clay/)
  for (const id of ['engine-status', 'library-action-status', 'task-action-status']) {
    const band = app.match(new RegExp(`id="${id}"[\\s\\S]*?className="([^"]+)"`))
    assert.ok(band, `${id} band is present`)
    assert.doesNotMatch(band[1], /bg-clay|border-clay/, `${id} keeps a neutral band`)
    assert.match(band[1], /bg-raised/, `${id} uses the raised surface`)
    const near = app.slice(app.indexOf(`id="${id}"`)).slice(0, 900)
    assert.match(near, /CircleAlert/, `${id} marks the state`)
    assert.match(near, /text-clay/, `${id} puts the hue on the mark`)
  }
})

test('no workspace surface washes its background with the error hue', () => {
  for (const [name, source] of [['App.tsx', app], ['Inspector.tsx', inspector]]) {
    // The old pattern only ever appeared as an alpha wash (bg-clay/[0.0x]).
    // Filled destructive buttons (bg-clay/15) are a deliberate exception.
    assert.doesNotMatch(source, /bg-clay\/\[/, `${name} tints a surface instead of marking it`)
  }
})

test('failed rows fade the values the hover actions would cover', () => {
  assert.match(row, /coveredColumns/)
  assert.match(row, /task-action-covered/)
  const css = fs.readFileSync('src/renderer/src/components/ui/workspace.css', 'utf8')
  assert.match(css, /:is\(:hover, :has\(:focus-visible\)\) \.task-action-covered \{ opacity: 0; \}/)
  assert.match(row, /ROW_ACTION_OVERLAY_WIDTH/)
  assert.match(row, /ROW_ACTION_OVERLAY_INSET/)
  // Progress keeps its own line, so it is exempt while a row is transferring.
  assert.match(row, /column === 'progress' && showProgress/)
})
