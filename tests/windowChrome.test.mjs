import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryTitlebarLayout, MAC_WINDOW_CONTROL_SAFE_AREA } from '../src/shared/windowChrome.ts'

const pane = { platform: 'darwin', fullScreen: false, zoomFactor: 1, paneLeft: 0, paneTop: 0, paneWidth: 1220 }

function assertClear(input) {
  const layout = libraryTitlebarLayout(input)
  const physicalLeft = (input.paneLeft + 16 + layout.controlsInset) * input.zoomFactor
  const physicalTop = (input.paneTop + layout.paddingTop) * input.zoomFactor
  assert.ok(physicalLeft >= MAC_WINDOW_CONTROL_SAFE_AREA.right || physicalTop >= MAC_WINDOW_CONTROL_SAFE_AREA.bottom,
    `toolbar (${physicalLeft}, ${physicalTop}) must clear the native controls`)
  const headingLeft = (input.paneLeft + 16) * input.zoomFactor
  const headingTop = (input.paneTop + layout.paddingTop + 40) * input.zoomFactor
  assert.ok(headingLeft >= MAC_WINDOW_CONTROL_SAFE_AREA.right || headingTop >= MAC_WINDOW_CONTROL_SAFE_AREA.bottom - 0.001,
    `unindented heading (${headingLeft}, ${headingTop}) must also clear the native controls`)
  return layout
}

test('collapsing the sidebar clears native controls without indenting the library heading', () => {
  assert.deepEqual(libraryTitlebarLayout({ ...pane, paneLeft: 208, paneWidth: 1012 }), { paddingTop: 12, controlsInset: 0 })
  assert.deepEqual(assertClear(pane), { paddingTop: 12, controlsInset: 72 })
})

test('native clearance survives renderer zoom, narrow windows and custom sidebar widths', () => {
  for (const zoomFactor of [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.8, 2, 3]) {
    for (const nativeWidth of [720, 960, 1220]) {
      for (const paneLeft of [0, 164, 208, 300]) {
        const paneWidth = nativeWidth / zoomFactor - paneLeft
        if (paneWidth < 200) continue
        assertClear({ ...pane, zoomFactor, paneLeft, paneWidth })
      }
    }
  }
})

test('compact windows place the toolbar below the controls to preserve search space', () => {
  assert.deepEqual(assertClear({ ...pane, paneWidth: 420 }), { paddingTop: 48, controlsInset: 0 })
  assert.deepEqual(assertClear({ ...pane, paneWidth: 360, zoomFactor: 2 }), { paddingTop: 24, controlsInset: 0 })
})

test('zooming out keeps the library heading below the native controls', () => {
  assert.deepEqual(assertClear({ ...pane, zoomFactor: 0.5 }), { paddingTop: 56, controlsInset: 160 })
})

test('fullscreen, browser previews and a toolbar already below the controls need no macOS inset', () => {
  for (const change of [{ fullScreen: true }, { platform: 'web' }, { platform: 'win32' }, { paneTop: 60 }]) {
    assert.deepEqual(libraryTitlebarLayout({ ...pane, ...change }), { paddingTop: 12, controlsInset: 0 })
  }
})

test('an invalid zoom report falls back to a safe actual-size reservation', () => {
  for (const zoomFactor of [NaN, Infinity, 0, -1]) {
    assert.deepEqual(libraryTitlebarLayout({ ...pane, zoomFactor }), libraryTitlebarLayout(pane))
  }
})
