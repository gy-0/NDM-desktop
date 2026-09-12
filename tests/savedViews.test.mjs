import assert from 'node:assert/strict'
import test from 'node:test'
import { activityWindowStart, addSavedView, criteriaFromFilter, criteriaWithSidebarFilter, DEFAULT_VIEW_CRITERIA, filterTasksForView, parseSavedViews, primaryFilterForView, removeSavedView, renameSavedView, savedViewMatches, serializeSavedViews, viewCriteriaSummary } from '../src/renderer/src/lib/savedViews.ts'

const sort = { key: 'activity', direction: 'desc' }
const criteria = { ...DEFAULT_VIEW_CRITERIA, status: 'failed', type: 'document', query: 'design' }
const task = (id, changes = {}) => ({ id, filename: 'Design.pdf', title: '', url: 'https://example.com/file', source: 'example.com', category: 'document', status: 'error', activityAt: new Date(2026, 8, 12, 9).getTime(), ...changes })

test('combined views intersect status, type, normalized search and recent activity', () => {
  const now = new Date(2026, 8, 12, 12).getTime()
  const rows = [task(1), task(2, { status: 'complete' }), task(3, { category: 'compressed' }), task(4, { filename: 'Other.pdf' }), task(5, { activityAt: new Date(2026, 7, 1).getTime() })]
  assert.deepEqual(filterTasksForView(rows, { ...criteria, query: 'ＤＥＳＩＧＮ example.com', time: 'week' }, now).map(row => row.id), [1])
  assert.equal(filterTasksForView(rows, criteria, now).length, 2)
  assert.equal(viewCriteriaSummary({ ...criteria, time: 'week' }), '失败任务 · 文档 · 最近活动：最近 7 天 · “design”')
})

test('local calendar windows include the boundary and exclude unknown and future activity', () => {
  const now = new Date(2026, 8, 12, 12, 30).getTime()
  const today = new Date(2026, 8, 12).getTime()
  assert.equal(activityWindowStart('today', now), today)
  assert.equal(activityWindowStart('week', now), new Date(2026, 8, 6).getTime())
  assert.equal(activityWindowStart('month', now), new Date(2026, 7, 14).getTime())
  const rows = [task(1, { activityAt: today }), task(2, { activityAt: today - 1 }), task(3, { activityAt: undefined }), task(4, { activityAt: now + 1 })]
  assert.deepEqual(filterTasksForView(rows, { ...DEFAULT_VIEW_CRITERIA, time: 'today' }, now).map(row => row.id), [1])
  assert.equal(filterTasksForView(rows, DEFAULT_VIEW_CRITERIA, now).length, 4)
  assert.equal(filterTasksForView(rows, { ...DEFAULT_VIEW_CRITERIA, time: 'today' }, new Date(2026, 8, 13, 12).getTime()).length, 0)
})

test('sidebar replaces one visible dimension while All resets every condition', () => {
  const current = { ...criteria, time: 'week' }
  assert.deepEqual(criteriaWithSidebarFilter(current, 'video'), { ...current, type: 'video' })
  assert.deepEqual(criteriaWithSidebarFilter(current, 'completed'), { ...current, status: 'completed' })
  assert.deepEqual(criteriaWithSidebarFilter(current, 'all'), DEFAULT_VIEW_CRITERIA)
  assert.deepEqual(criteriaFromFilter('document', 'hello'), { ...DEFAULT_VIEW_CRITERIA, type: 'document', query: 'hello' })
  assert.equal(primaryFilterForView(current), 'failed')
  assert.equal(primaryFilterForView({ ...current, status: 'all' }), 'document')
})

test('paused views include recoverable incomplete tasks', () => {
  const rows = [task(1, { status: 'paused' }), task(2, { status: 'incomplete' }), task(3, { status: 'error' })]
  assert.deepEqual(filterTasksForView(rows, { ...DEFAULT_VIEW_CRITERIA, status: 'paused' }).map(row => row.id), [1, 2])
})

test('save, rename and remove preserve criteria snapshots and leave inputs unchanged', () => {
  const source = { ...criteria }
  const added = addSavedView([], ' 设计跟进 ', source, sort, 'one', 100)
  assert.equal(added.ok, true)
  source.query = 'changed'
  assert.equal(added.views[0].criteria.query, 'design')
  const renamed = renameSavedView(added.views, 'one', '本周设计跟进', 200)
  assert.equal(renamed.ok, true)
  assert.equal(renamed.views[0].name, '本周设计跟进')
  assert.equal(renamed.views[0].createdAt, 100)
  assert.equal(renamed.views[0].updatedAt, 200)
  assert.equal(added.views[0].name, '设计跟进')
  const removed = removeSavedView(renamed.views, 'one')
  assert.deepEqual(removed.views, [])
  assert.equal(renamed.views.length, 1)
})

test('names cannot be empty, too long or visually duplicate after normalization', () => {
  const initial = addSavedView([], 'Design', criteria, sort, 'one', 100).views
  assert.equal(addSavedView(initial, ' ＤＥＳＩＧＮ ', criteria, sort, 'two', 100).ok, false)
  assert.equal(addSavedView(initial, ' ', criteria, sort, 'two', 100).ok, false)
  assert.equal(addSavedView(initial, '文'.repeat(41), criteria, sort, 'two', 100).ok, false)
  assert.equal(renameSavedView(initial, 'missing', 'Other').ok, false)
  assert.equal(removeSavedView(initial, 'missing').ok, false)
})

test('versioned persistence survives reload and tolerates malformed individual entries', () => {
  const view = addSavedView([], 'Design', criteria, sort, 'one', 100).views[0]
  assert.deepEqual(parseSavedViews(serializeSavedViews([view])), [view])
  assert.deepEqual(parseSavedViews(JSON.stringify({ version: 1, views: [null, { ...view, id: 'invalid', criteria: { ...criteria, time: 'forever' } }, view, view] })), [view])
  assert.deepEqual(parseSavedViews('{not valid'), [])
  assert.deepEqual(parseSavedViews(JSON.stringify({ version: 2, views: [view] })), [])
})

test('active saved view identity includes every condition and sort direction', () => {
  const view = addSavedView([], 'Design', criteria, sort, 'one', 100).views[0]
  assert.equal(savedViewMatches(view, { ...criteria, query: '  ＤＥＳＩＧＮ ' }, sort), true)
  assert.equal(savedViewMatches(view, { ...criteria, time: 'week' }, sort), false)
  assert.equal(savedViewMatches(view, criteria, { ...sort, direction: 'asc' }), false)
})
