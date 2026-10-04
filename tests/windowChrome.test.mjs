import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryTitlebarLayout, MAC_WINDOW_CONTROL_SAFE_AREA, WINDOWS_TITLEBAR_HEIGHT, windowsTitlebarHeight, windowsPaneTitlebarLayout } from '../src/shared/windowChrome.ts'

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

test('Windows converts native control geometry at every renderer zoom', () => {
  for (const zoom of [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.8, 2, 3]) {
    assert.ok(Math.abs(windowsTitlebarHeight(false, zoom) * zoom - WINDOWS_TITLEBAR_HEIGHT) < 0.001)
    assert.equal(windowsTitlebarHeight(true, zoom), 0)
  }
  for (const zoom of [NaN, Infinity, 0, -1]) {
    assert.equal(windowsTitlebarHeight(false, zoom), WINDOWS_TITLEBAR_HEIGHT)
  }
})

test('Windows integrates controls in the toolbar and releases space when details owns the right edge', () => {
  const input = { paneLeft: 208, paneTop: 0, paneWidth: 1012, viewportWidth: 1220, controlsWidth: 138, controlsHeight: 52 }
  assert.deepEqual(windowsPaneTitlebarLayout(input), { paddingTop: 10, controlsInsetRight: 134 })
  assert.deepEqual(windowsPaneTitlebarLayout({ ...input, paneWidth: 652 }), { paddingTop: 12, controlsInsetRight: 0 })
  assert.deepEqual(windowsPaneTitlebarLayout({ ...input, controlsWidth: 0, controlsHeight: 0 }), { paddingTop: 12, controlsInsetRight: 0 })
})

test('Windows pane geometry clears native controls across narrow widths, zoom and control sizes', () => {
  for (const zoom of [.5, .67, 1, 1.25, 1.8, 3]) {
    for (const width of [720, 920, 1440]) {
      for (const controlsWidth of [138, 174, 210]) {
        const input = { paneLeft: 0, paneTop: 0, paneWidth: width / zoom, viewportWidth: width / zoom, controlsWidth: controlsWidth / zoom, controlsHeight: 52 / zoom }
        const layout = windowsPaneTitlebarLayout(input)
        const right = input.paneWidth - 16 - layout.controlsInsetRight
        assert.ok(right <= input.viewportWidth - input.controlsWidth + .001 || layout.paddingTop >= input.controlsHeight)
      }
    }
  }
})


test('Windows search row aligns with the native centre and leaves a separate control gap', () => {
  for (const zoom of [.5, .67, 1]) {
    const width = 1440 / zoom
    const input = { paneLeft: 0, paneTop: 0, paneWidth: width, viewportWidth: width, controlsWidth: 138 / zoom, controlsHeight: 52 / zoom }
    const layout = windowsPaneTitlebarLayout(input)
    assert.ok(Math.abs((layout.paddingTop + 16) * zoom - 26) < .001)
    assert.ok(Math.abs(width - input.controlsWidth - (width - 16 - layout.controlsInsetRight) - 12) < .001)
  }
})
