import assert from 'node:assert/strict'
import test from 'node:test'
import { coveredTrailingColumns, fitLibraryColumns, fitTableColumns, tableColumnMinimums } from '../src/renderer/src/lib/tableLayout.ts'
const preferred = { filename: 340, status: 96, size: 124, activity: 118, progress: 150 }
test('table fits every pane width, including extreme saved preferences', () => {
  for (const prefs of [preferred, {...preferred, filename: 5000}, {...preferred, status: 5000}, {...preferred, filename: 1}]) {
    for (let width = 240; width <= 2400; width += 7) {
      const fitted = fitTableColumns(width, prefs)
      const minimum = tableColumnMinimums(width)
      assert.ok(Math.abs(Object.values(fitted).reduce((a,b) => a+b,0) - width) < 0.001)
      for (const key of Object.keys(fitted)) {
        assert.ok(fitted[key] >= minimum[key] - 0.001)
        if (!minimum[key]) assert.equal(fitted[key], 0)
      }
    }
  }
})
test('secondary columns return when the pane grows and preserve relative preferences', () => {
  assert.equal(fitTableColumns(400, preferred).status, 0)
  assert.equal(fitTableColumns(550, preferred).size, 0)
  assert.ok(fitTableColumns(600, preferred).size >= 100)
  assert.equal(fitTableColumns(750, preferred).activity, 0)
  const wide = fitTableColumns(1800, preferred)
  assert.ok(wide.activity >= 102)
  assert.ok(Math.abs(wide.filename / wide.progress - preferred.filename / preferred.progress) < 0.001)
})

test('library widths prioritize identity and never depend on task state', () => {
  for (let width=240;width<2400;width+=13) {
    const fitted=fitLibraryColumns(width,preferred)
    assert.equal(fitted.progress,0)
    assert.equal(Object.values(fitted).reduce((a,b)=>a+b,0),width)
    assert.ok(fitted.filename>=Math.min(width,300))
  }
  assert.equal(fitLibraryColumns(800,preferred).activity,0)
})

test('row actions only cover trailing columns whose values would sit under them', () => {
  // 1012px pane: the width the real window uses once the sidebar and padding
  // are removed. Progress is absent, so time and size are the covered pair.
  const library = fitLibraryColumns(1012, preferred)
  assert.equal(coveredTrailingColumns(library), 'activity,size')
  // A narrow pane drops time first; size and the status value sit under the
  // buttons together (the collision the earlier build shipped).
  assert.equal(coveredTrailingColumns(fitLibraryColumns(700, preferred)), 'size,status')
  // Below 580px only the status column is left, and it is the covered one.
  assert.equal(coveredTrailingColumns(fitLibraryColumns(520, preferred)), 'status')
  // Once a column's right edge clears the buttons it stays painted.
  const wide = fitLibraryColumns(1600, preferred)
  assert.equal(coveredTrailingColumns(wide), 'activity,size')
  // Transfer views carry a progress column, and its minimum already reaches
  // under the buttons, so the time column stays legible.
  const transfer = fitTableColumns(1200, preferred)
  assert.equal(coveredTrailingColumns(transfer), 'progress')
  assert.equal(coveredTrailingColumns(fitTableColumns(600, preferred)), 'progress')
})

test('covered trailing columns are a subset of the columns a pane actually shows', () => {
  for (let width = 240; width < 2400; width += 11) {
    for (const fitted of [fitTableColumns(width, preferred), fitLibraryColumns(width, preferred)]) {
      for (const key of coveredTrailingColumns(fitted).split(',').filter(Boolean)) {
        assert.ok(fitted[key] > 0, `${key} is hidden by the layout at ${width}px`)
      }
    }
  }
})
