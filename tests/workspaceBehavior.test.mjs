import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterLibraryTasks, workspaceHero, selectionRange, moveSelection } from '../src/renderer/src/lib/workspace.ts'
import { setTaskPaused, startClock } from '../src/renderer/src/lib/store.ts'

const task = (id, status = 'downloading', extra = {}) => ({
  id, status, category: 'document', filename: `File-${id}.pdf`, title: `任务 ${id}`,
  url: `https://example.com/${id}`, source: 'example.com', fileSize: 100,
  completedBytes: 20, bytesPerSecond: 0, connections: 4, segments: [], folderPath: '/qa', ...extra
})
const rows = [task(1), task(2, 'paused'), task(3, 'incomplete'), task(4, 'complete'), task(5, 'error'), task(6, 'waiting')]

for (const filter of ['paused', 'queued', 'completed', 'failed']) {
  test(`the ${filter} view never subtracts a hidden spotlight from the list`, () => {
    const visible = filterLibraryTasks(rows, filter, '')
    for (const id of rows.map((row) => row.id)) assert.equal(workspaceHero(visible, filter, '', id), undefined)
    assert.ok(visible.length > 0)
  })
}
test('search suppresses even a matching Hero so every result is in the list', () => {
  assert.equal(workspaceHero(rows, 'all', 'File', 1), undefined)
  assert.equal(workspaceHero(rows, 'all', 'NO-MATCH', 1), undefined)
})
test('a paused spotlight remains available on the dashboard but not in active-only views', () => {
  assert.equal(workspaceHero(rows, 'all', '', 2)?.id, 2)
  const active = filterLibraryTasks(rows, 'active', '')
  assert.equal(workspaceHero(active, 'active', '', 2)?.id, 1)
})
test('blank search preserves a live spotlight and invalid spotlight falls back', () => {
  assert.equal(workspaceHero(rows, 'all', '  ', 1)?.id, 1)
  assert.equal(workspaceHero(rows, 'all', '', 4)?.id, 1)
  assert.equal(workspaceHero([], 'all', '', 999), undefined)
})
test('search ANDs words across filename and website without requiring their order', () => {
  const input = [task(1, 'paused', { filename: 'Design Systems.pdf', source: 'learn.example.org' }), task(2)]
  assert.deepEqual(filterLibraryTasks(input, 'all', 'example.org DESIGN').map((t) => t.id), [1])
  assert.deepEqual(filterLibraryTasks(input, 'all', 'Design missing'), [])
})
test('full-width input, case and whitespace normalize before matching', () => {
  assert.deepEqual(filterLibraryTasks(rows, 'all', '　ＦＩＬＥ－１　\nＰＤＦ ').map((t) => t.id), [1])
})
test('Chinese titles, collection names and captured page URLs are searchable', () => {
  const input = [task(1, 'paused', { collection: { id: 'c', title: '设计课程', index: 1, count: 2 }, pageURL: 'https://learn.example.org/watch' })]
  for (const q of ['任务', '设计', 'learn.example.org', '课程 WATCH']) assert.equal(filterLibraryTasks(input, 'all', q).length, 1)
})
test('search never leaks results from other status/category filters', () => {
  assert.deepEqual(filterLibraryTasks(rows, 'paused', 'FILE').map((t) => t.id), [2, 3])
  assert.deepEqual(filterLibraryTasks(rows, 'audio', 'FILE'), [])
})
test('empty search returns matching rows without mutating the input order', () => {
  assert.deepEqual(filterLibraryTasks(rows, 'all', '\t'), rows)
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3, 4, 5, 6])
})
test('range selection uses IDs after a live reorder, not a stale row index', () => {
  assert.deepEqual([...selectionRange([8, 2, 6, 1], 2, 1)], [2, 6, 1])
  assert.deepEqual([...selectionRange([8, 2, 6, 1], 1, 2)], [2, 6, 1])
})
test('removed anchors fall back to one target and absent targets select nothing', () => {
  assert.deepEqual([...selectionRange([2, 6], 8, 6)], [6])
  assert.deepEqual([...selectionRange([2, 6], 2, 8)], [])
})
test('Shift navigation grows past two rows, shrinks, and crosses the anchor', () => {
  const ids = [1, 2, 3, 4, 5]
  let state = { anchorId: 2, focusId: 2 }
  for (let i = 0; i < 3; i++) state = moveSelection(ids, state.anchorId, state.focusId, 1, true)
  assert.deepEqual([...state.selected], [2, 3, 4, 5])
  for (let i = 0; i < 4; i++) state = moveSelection(ids, state.anchorId, state.focusId, -1, true)
  assert.deepEqual([...state.selected], [1, 2])
  assert.equal(state.anchorId, 2)
})
test('plain arrow navigation resets the range anchor and clamps at both edges', () => {
  const moved = moveSelection([1, 2, 3], 1, 2, 1, false)
  assert.deepEqual([...moved.selected], [3])
  assert.equal(moved.anchorId, 3)
  assert.equal(moveSelection([1, 2, 3], 3, 3, 1, false).focusId, 3)
  assert.equal(moveSelection([1, 2, 3], 1, 1, -1, false).focusId, 1)
})
test('navigation handles no selection, a removed focus and an empty list', () => {
  assert.equal(moveSelection([7, 9], null, null, 1, false).focusId, 7)
  assert.equal(moveSelection([7, 9], null, null, -1, false).focusId, 9)
  assert.equal(moveSelection([7, 9], 99, 99, 1, true).anchorId, 7)
  assert.deepEqual(moveSelection([], 7, 9, 1, true), { selected: new Set(), anchorId: null, focusId: null })
})

function engineFixture() {
  const originalWindow = globalThis.window
  let listener
  const calls = []
  let reply = { ok: true }
  globalThis.window = { ndm: {
    request: async (op, extra) => { if (op === 'list') return {}; calls.push({ op, ...extra }); return reply },
    status: async () => 'live', getEngineError: async () => null,
    onEvent: (cb) => { listener = cb; return () => {} }, onStatus: () => () => {}, notifySnapshot: () => {}
  } }
  const stop = startClock()
  listener({ op: 'snapshot', tasks: rows })
  calls.length = 0
  return { calls, reply: (value) => { reply = value }, push: (tasks) => listener({ op: 'snapshot', tasks }),
    close: () => { stop(); globalThis.window = originalWindow } }
}
test('batch pause intent never resumes a task paused by a newer snapshot', async () => {
  const f = engineFixture()
  try {
    await setTaskPaused(1, true)
    assert.deepEqual(f.calls, [{ op: 'pause', taskID: 1 }])
    f.push([task(1, 'paused')])
    await setTaskPaused(1, true)
    assert.equal(f.calls.length, 1)
  } finally { f.close() }
})
test('batch resume intent never pauses a task resumed by a newer snapshot', async () => {
  const f = engineFixture()
  try {
    await setTaskPaused(2, false)
    assert.deepEqual(f.calls, [{ op: 'resume', taskID: 2 }])
    f.push([task(2)])
    await setTaskPaused(2, false)
    assert.equal(f.calls.length, 1)
  } finally { f.close() }
})
test('completed rows are no-ops, removed rows and failed acknowledgements are not successes', async () => {
  const f = engineFixture()
  try {
    await setTaskPaused(4, true)
    await setTaskPaused(4, false)
    assert.equal(f.calls.length, 0)
    await assert.rejects(setTaskPaused(999, false), /任务已不在列表中/)
    f.reply({ ok: false })
    await assert.rejects(setTaskPaused(1, true), /未能暂停任务/)
    await assert.rejects(setTaskPaused(2, false), /未能继续任务/)
  } finally { f.close() }
})
