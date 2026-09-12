import assert from 'node:assert/strict'
import test from 'node:test'
import { TASK_ACTION_RAIL_WIDTH, fitTaskColumns, fitLibraryColumns, fitTableColumns, tableColumnMinimums } from '../src/renderer/src/lib/tableLayout.ts'
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

test('task identity and actions never share width at narrow sizes or extreme preferences', () => {
  for (const transferView of [true, false]) {
    for (const prefs of [preferred, { ...preferred, filename: 5000 }, { ...preferred, filename: 1 }]) {
      for (let width = 300; width < 1800; width += 13) {
        const fitted = fitTaskColumns(width, prefs, transferView)
        const contentWidth = width - TASK_ACTION_RAIL_WIDTH
        assert.ok(Math.abs(Object.values(fitted).reduce((sum, width) => sum + width, 0) - contentWidth) < .001)
        if (contentWidth < 440) assert.equal(fitted.filename, contentWidth)
        if (contentWidth < 600) assert.equal(fitted.progress, 0, 'narrow progress belongs below the name')
      }
    }
  }
})
